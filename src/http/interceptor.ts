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
import { AgentRetraceError, ProviderCallBlockedError } from "../errors.js";
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
import {
  HANDLED,
  playResponse,
  type ResponseSink,
  type TeeObserver,
  teeHandler,
  toSink,
} from "./handler.js";

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
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new TypeError("agent-retrace cannot read this kind of request body");
}

/**
 * Converts one header value to the text undici sends for it.
 *
 * @param value - A header value as the caller gave it.
 * @returns The text: null is sent as an empty value.
 */
function headerText(value: unknown): string {
  return value === null ? "" : String(value);
}

/**
 * Converts request headers in any of the forms undici accepts to a record,
 * leaving out the headers undici does not send (a value of undefined).
 *
 * @param headers - A record (values may be arrays), a flat `[name, value, ...]` array, or an iterable of pairs.
 * @returns The headers, repeated values joined by ", ".
 */
function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  /**
   * Adds one header to `out`, joining it to an earlier one of the same name.
   *
   * @param name - Header name.
   * @param value - Header value, possibly an array.
   */
  const add = (name: unknown, value: unknown) => {
    if (value === undefined) return;
    const key = String(name);
    const text = Array.isArray(value) ? value.map(headerText).join(", ") : headerText(value);
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
 * @param sink - Where the response goes, from `toSink(handler)`.
 * @param message - What went wrong.
 */
function refuse(sink: ResponseSink, message: string): void {
  playResponse(sink, encodeResponse(errorResponse(stripVTControlCharacters(message))));
}

/**
 * Fails a request with an error the way undici does when it cannot send one,
 * so the caller sees the real error (`fetch` puts it in `cause`).
 *
 * @param sink - Where the response goes, from `toSink(handler)`.
 * @param err - The error.
 */
function failRequest(sink: ResponseSink, err: unknown): void {
  sink.start(() => {});
  sink.error(err instanceof Error ? err : new Error(String(err)));
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
    /** Keeps the status and headers. */
    headers(s, h) {
      status = s;
      headers = h;
    },
    /** Keeps the chunk. */
    data(chunk) {
      chunks.push(chunk);
    },
    end: record,
    /** Records what arrived before a consumer abort, drops anything else. */
    error(_err, byConsumer) {
      // Before the headers there is no response to store.
      if (byConsumer && status !== 0) return record();
      settle(undefined);
    },
  };
  original.dispatch(opts, teeHandler(handler, observer) as Dispatcher.DispatchHandler);
}

/**
 * Handles a request to a provider host made inside an open session, starting
 * at most one response on the handler. Rejects only when the handler's own
 * error callback throws.
 *
 * An error before the request is decided is answered by its kind: one of
 * agent-retrace's own (a blocked call) with a 400 the SDKs do not retry,
 * anything else (the caller's request body failing to read) with that error,
 * as undici would. An error thrown by the handler itself once its response
 * has started is passed to its error callback.
 *
 * @param original - The dispatcher we wrapped.
 * @param opts - The request options.
 * @param handler - The handler undici passed to `dispatch`.
 * @param session - The open session, told about credentials in the request.
 * @param decideLlm - Decides the request, from `session.reserveLlm()` taken when it was issued.
 * @param origin - Scheme, host and port of the request.
 */
async function handleInSession(
  original: Dispatcher,
  opts: Dispatcher.DispatchOptions,
  handler: object,
  session: Session,
  decideLlm: ReturnType<Session["reserveLlm"]>,
  origin: string,
): Promise<void> {
  const sink = toSink(handler);
  // Worked out first and run once, so a failure while delivering never
  // starts a second response.
  let deliver: () => void;
  try {
    const body = await collectBody(opts.body);
    const config = getConfig();
    const { request, secrets } = captureRequest(
      {
        method: opts.method,
        origin,
        path: opts.path,
        headers: headersToRecord(opts.headers),
        body,
      },
      config,
    );
    session.noteSecrets(secrets);
    const decision = decideLlm(request);
    if (decision.kind === "replay") {
      deliver = () => playResponse(sink, encodeResponse(decision.step.response));
    } else if (decision.kind === "fail") {
      deliver = () => refuse(sink, decision.error.message);
    } else {
      const forwarded = { ...opts, body, [HANDLED]: true } as Dispatcher.DispatchOptions;
      const live = { request, secrets, config, commit: decision.commit };
      deliver = () => forwardAndRecord(original, forwarded, handler, live);
    }
  } catch (err) {
    deliver =
      err instanceof AgentRetraceError
        ? () => refuse(sink, err.message)
        : () => failRequest(sink, err);
  }
  try {
    deliver();
  } catch (err) {
    sink.error(err instanceof Error ? err : new Error(String(err)));
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
      refuse(toSink(handler), (err as Error).message);
      return true;
    }
  }
  if (session.closed) {
    refuse(toSink(handler), new ProviderCallBlockedError(url.href, "after-replay").message);
    return true;
  }
  // The sequence number is taken now, before reading the body takes any time.
  const decideLlm = session.reserveLlm();
  void handleInSession(original, opts, handler, session, decideLlm, origin);
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
      /**
       * The guarded `request` or `get`: throws for a provider host while
       * provider calls must go through `fetch`, otherwise calls the original.
       *
       * @param args - The arguments of the call.
       * @returns What the original returns.
       * @throws {ProviderCallBlockedError} For a provider host inside a replay or in replay mode.
       */
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
