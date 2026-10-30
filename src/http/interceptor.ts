/**
 * Interception of provider HTTP calls.
 *
 * Node's built-in `fetch` is undici. Every request goes through a
 * "dispatcher" object that `fetch` looks up on every call under a well-known
 * key on `globalThis`. Replacing that object with a wrapper therefore catches
 * requests from SDK clients that were built before the test started, which a
 * patched `fetch` function passed to a client would not.
 */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { Agent, type Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { getConfig, isProviderHost, resolveMode } from "../config.js";
import { ProviderCallBlockedError } from "../errors.js";
import type { LlmStep, RecordedResponse } from "../recording/format.js";
import { runtime } from "../runtime.js";
import type { Session } from "../session.js";
import {
  captureRequest,
  captureResponse,
  encodeResponse,
  errorResponse,
  isTransientStatus,
} from "./capture.js";
import { HANDLED, playResponse, type TeeObserver, teeHandler, toSink } from "./handler.js";

/**
 * Collects a request body into one buffer.
 *
 * @param body - A string, bytes, or a (sync or async) iterable of either, as undici accepts.
 * @returns The bytes, or undefined when there is no body.
 * @throws {TypeError} When the body has a type that cannot be read.
 */
async function collectBody(body: unknown): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (Symbol.asyncIterator in (body as object) || Symbol.iterator in (body as object)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<string | Uint8Array>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new TypeError("agent-retrace cannot read this kind of request body");
}

/**
 * Converts request headers in any of the forms undici accepts to a record.
 *
 * @param headers - A record (values may be arrays), a flat `[name, value, ...]` array, or an iterable of pairs.
 * @returns The headers, repeated values joined by ", ".
 */
function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (name: unknown, value: unknown) => {
    const key = String(name);
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    out[key] = key in out ? `${out[key]}, ${text}` : text;
  };
  if (headers === undefined || headers === null) return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) add(headers[i], headers[i + 1]);
  } else if (Symbol.iterator in (headers as object)) {
    for (const [name, value] of headers as Iterable<[string, string]>) add(name, value);
  } else {
    for (const [name, value] of Object.entries(headers as object)) add(name, value);
  }
  return out;
}

/**
 * Answers a request with a refusal instead of sending it.
 *
 * @param handler - The handler undici passed to `dispatch`.
 * @param message - What went wrong.
 */
function refuse(handler: object, message: string): void {
  playResponse(toSink(handler), encodeResponse(errorResponse(stripVTControlCharacters(message))));
}

/** What `forwardAndRecord` needs to turn a live response into a step. */
interface LiveRecording {
  request: LlmStep["request"];
  secrets: string[];
  config: ReturnType<typeof getConfig>;
  commit(step: LlmStep | undefined): void;
}

/**
 * Sends a request to the real dispatcher, recording the response when it
 * completes. The step is handed to the session exactly once: dropped for a
 * transient failure, a network error, or a response that cannot be stored.
 *
 * A response the consumer aborts after its headers arrived (an SDK stream
 * the agent stopped reading) is recorded with the body received so far. The
 * request did happen, and an agent that stops at the same point on replay
 * reads the same events.
 *
 * @param original - The dispatcher we wrapped.
 * @param opts - The request options, with the body already collected.
 * @param handler - The handler undici passed to `dispatch`.
 * @param live - The request half of the step, and how to hand the step to the session.
 */
function forwardAndRecord(
  original: Dispatcher,
  opts: Dispatcher.DispatchOptions,
  handler: object,
  live: LiveRecording,
): void {
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let settled = false;
  /**
   * Hands the step to the session, the first time only.
   *
   * @param value - The step, or undefined to drop it.
   */
  const settle = (value: LlmStep | undefined) => {
    if (settled) return;
    settled = true;
    live.commit(value);
  };
  /** Records the response received so far, unless it is not worth storing. */
  const record = () => {
    if (isTransientStatus(status)) return settle(undefined);
    let response: RecordedResponse;
    try {
      response = captureResponse(status, headers, Buffer.concat(chunks), live.secrets, live.config);
    } catch (err) {
      // The caller already has its response; only the recording is affected.
      process.emitWarning((err as Error).message, "AgentRetraceWarning");
      return settle(undefined);
    }
    settle({ type: "llm", request: live.request, response });
  };
  const observer: TeeObserver = {
    headers(s, h) {
      status = s;
      headers = h;
    },
    data(chunk) {
      chunks.push(chunk);
    },
    end: record,
    error(_err, byConsumer) {
      // Before the headers there is no response to store.
      if (byConsumer && status !== 0) return record();
      settle(undefined);
    },
  };
  original.dispatch(opts, teeHandler(handler, observer) as Dispatcher.DispatchHandler);
}

/**
 * Handles a request to a provider host made inside an open session.
 *
 * @param original - The dispatcher we wrapped.
 * @param opts - The request options.
 * @param handler - The handler undici passed to `dispatch`.
 * @param decideLlm - Decides the request, from `session.reserveLlm()` taken when it was issued.
 * @param origin - Scheme, host and port of the request.
 */
async function handleInSession(
  original: Dispatcher,
  opts: Dispatcher.DispatchOptions,
  handler: object,
  decideLlm: ReturnType<Session["reserveLlm"]>,
  origin: string,
): Promise<void> {
  const body = await collectBody(opts.body);
  const config = getConfig();
  const { request, secrets } = captureRequest(
    { method: opts.method, origin, path: opts.path, headers: headersToRecord(opts.headers), body },
    config,
  );
  const decision = decideLlm(request);
  if (decision.kind === "replay") {
    playResponse(toSink(handler), encodeResponse(decision.step.response));
  } else if (decision.kind === "fail") {
    refuse(handler, decision.error.message);
  } else {
    const forwarded = { ...opts, body, [HANDLED]: true } as Dispatcher.DispatchOptions;
    forwardAndRecord(original, forwarded, handler, {
      request,
      secrets,
      config,
      commit: decision.commit,
    });
  }
}

/**
 * The `dispatch` method of the wrapper: the whole interception flow.
 *
 * @param original - The dispatcher we wrapped.
 * @param opts - The request options.
 * @param handler - The handler undici passed to `dispatch`.
 * @returns What undici expects from `dispatch`: false asks the caller to wait before sending more.
 */
function intercept(
  original: Dispatcher,
  opts: Dispatcher.DispatchOptions,
  handler: Dispatcher.DispatchHandler,
): boolean {
  // Already seen by an interceptor above this one in the stack.
  if (HANDLED in opts || HANDLED in handler) return original.dispatch(opts, handler);
  const rawOrigin = opts.origin;
  if (rawOrigin === undefined) return original.dispatch(opts, handler);
  const origin = (typeof rawOrigin === "string" ? rawOrigin : rawOrigin.origin).replace(/\/$/, "");
  let url: URL;
  try {
    // Concatenated, not resolved: a path starting with "//" would otherwise change the host.
    url = new URL(`${origin}${opts.path}`);
  } catch {
    return original.dispatch(opts, handler);
  }
  if (!isProviderHost(url)) return original.dispatch(opts, handler);

  const session = runtime().als.getStore();
  if (session === undefined) {
    // Outside replay(): untouched and unrecorded, unless the mode forbids it.
    try {
      if (resolveMode() !== "replay") return original.dispatch(opts, handler);
      throw new ProviderCallBlockedError(url.href, "outside-replay");
    } catch (err) {
      refuse(handler, (err as Error).message);
      return true;
    }
  }
  if (session.closed) {
    refuse(handler, new ProviderCallBlockedError(url.href, "after-replay").message);
    return true;
  }
  // The sequence number is taken now, before reading the body takes any time.
  const decideLlm = session.reserveLlm();
  handleInSession(original, opts, handler, decideLlm, origin).catch((err: unknown) => {
    refuse(handler, err instanceof Error ? err.message : String(err));
  });
  return true;
}

/**
 * Wraps a dispatcher so that its `dispatch` goes through `intercept`. Every
 * other property is read from the original but not bound to it: methods such
 * as `request`, `stream` and `compose` call `this.dispatch`, which must be
 * the wrapper's.
 *
 * @param original - The dispatcher to wrap.
 * @returns The wrapper.
 */
function wrap(original: Dispatcher): Dispatcher {
  /**
   * The wrapper's `dispatch`.
   *
   * @param opts - The request options.
   * @param handler - The response handler.
   * @returns What `intercept` returns.
   */
  const dispatch = (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) =>
    intercept(original, opts, handler);
  return new Proxy(original, {
    get(target, prop, receiver) {
      return prop === "dispatch" ? dispatch : Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Installs the interceptor on undici's global dispatcher. Safe to call any
 * number of times, from any copy of the library: when the current dispatcher
 * is one of our wrappers nothing happens, and when someone else replaced it
 * (a mock agent, a proxy agent) it is wrapped again.
 */
export function installInterceptor(): void {
  const installed = runtime().installed;
  installed.dispatchers ??= new WeakSet();
  const wrappers = installed.dispatchers;
  // Importing undici sets a global Agent when none exists yet, so this is
  // defined even before the first `fetch`. The fallback covers a global that
  // was deleted afterwards.
  const current = getGlobalDispatcher() ?? new Agent();
  if (wrappers.has(current)) return;
  const wrapper = wrap(current);
  wrappers.add(wrapper);
  setGlobalDispatcher(wrapper);
}

/**
 * Works out which host a `node:http` or `node:https` request targets, from
 * any of the call forms: `(url, options?, cb?)` and `(options, cb?)`.
 *
 * @param args - The arguments of the call.
 * @param defaultProtocol - `http:` or `https:`, depending on the module.
 * @returns The target as a URL, or undefined when it cannot be worked out.
 */
function targetOf(args: unknown[], defaultProtocol: string): URL | undefined {
  const [first, second] = args;
  let url: URL | undefined;
  let options: Record<string, unknown> = {};
  try {
    if (typeof first === "string") url = new URL(first);
    else if (first instanceof URL) url = first;
    else if (typeof first === "object" && first !== null)
      options = first as Record<string, unknown>;
    if (url && typeof second === "object" && second !== null)
      options = second as Record<string, unknown>;
    const protocol = String(options.protocol ?? url?.protocol ?? defaultProtocol);
    const hostname = String(options.hostname ?? options.host ?? url?.hostname ?? "localhost");
    const port = options.port ?? url?.port;
    return new URL(`${protocol}//${hostname}${port ? `:${port}` : ""}`);
  } catch {
    return undefined;
  }
}

/**
 * Makes `node:http` and `node:https` refuse requests to provider hosts while
 * a replay is running or the mode is `replay`. agent-retrace intercepts
 * calls made with `fetch` (or undici) only, so a provider call made any other
 * way would silently reach the network or be missing from the recording.
 * Safe to call any number of times.
 */
export function installHttpGuard(): void {
  const installed = runtime().installed;
  if (installed.httpGuard) return;
  installed.httpGuard = true;
  for (const [mod, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ] as const) {
    for (const name of ["request", "get"] as const) {
      const original = mod[name] as (...args: unknown[]) => unknown;
      // Assigned onto the CommonJS exports object. The named exports that
      // ESM `import { request } from "node:https"` sees are copies, refreshed
      // below.
      (mod as unknown as Record<string, unknown>)[name] = function guarded(
        this: unknown,
        ...args: unknown[]
      ) {
        const target = targetOf(args, protocol);
        if (
          target &&
          isProviderHost(target) &&
          (runtime().als.getStore() !== undefined || resolveMode() === "replay")
        ) {
          throw new ProviderCallBlockedError(target.href, "node-http");
        }
        return original.apply(this, args);
      };
    }
  }
  syncBuiltinESMExports();
}
