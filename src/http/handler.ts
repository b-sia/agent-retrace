/**
 * Adapters between undici response handlers and plain callbacks.
 *
 * undici talks to a handler object with callbacks. Node 22 bundles undici 6,
 * which uses the legacy names (`onConnect`, `onHeaders`, `onData`,
 * `onComplete`, `onError`). Newer undici versions also accept a controller
 * style (`onRequestStart`, `onResponseStart`, ...). Which one a handler uses
 * depends on the Node version that built it, so both are supported here.
 */
import { STATUS_CODES } from "node:http";
import type { encodeResponse } from "./capture.js";

type Method = (...args: unknown[]) => unknown;
type Loose = Record<string, Method | undefined>;

/**
 * Marks requests already captured, on both the tee handler and the dispatch
 * options it is sent with. A second interceptor further down a stack of
 * dispatchers (two copies of the library, or a foreign wrapper that forwards
 * to ours) sees the mark and leaves the request alone instead of capturing
 * it twice. Foreign interceptors (undici's `compose`, retry and redirect)
 * wrap the handler but copy the options with a spread, which keeps the mark;
 * others rebuild the options but pass the handler on. `Symbol.for` so every
 * copy agrees on the key.
 */
export const HANDLED = Symbol.for("agent-retrace.handled.v1");

/** Where a replayed or live response is delivered, whichever API the consumer speaks. */
export interface ResponseSink {
  /**
   * Starts the response.
   *
   * @param abort - The function the consumer calls to cancel the response.
   */
  start(abort: (reason?: Error) => void): void;
  /**
   * Sends the status line and headers.
   *
   * @param status - HTTP status code.
   * @param headers - Header names (lowercase) and values.
   * @param statusText - Reason phrase, e.g. "OK".
   * @returns False when the consumer asks to pause (ignored: bodies are already in memory).
   */
  headers(status: number, headers: Record<string, string>, statusText: string): boolean;
  /**
   * Sends one body chunk.
   *
   * @param chunk - The bytes.
   * @returns False when the consumer asks to pause (ignored: bodies are already in memory).
   */
  data(chunk: Buffer): boolean;
  /** Ends the response successfully. */
  end(): void;
  /**
   * Ends the response with an error.
   *
   * @param err - The error, e.g. an `AbortError`.
   */
  error(err: Error): void;
}

/** Observes a live response as it passes through `teeHandler`. */
export interface TeeObserver {
  /**
   * Called with the status line and headers.
   *
   * @param status - HTTP status code.
   * @param headers - Header names (lowercase) and values.
   */
  headers(status: number, headers: Record<string, string>): void;
  /**
   * Called for each body chunk.
   *
   * @param chunk - The bytes.
   */
  data(chunk: Buffer): void;
  /** Called when the response ended successfully. */
  end(): void;
  /**
   * Called when the response failed.
   *
   * @param err - The error.
   * @param byConsumer - True when the consumer aborted the request (e.g. an SDK stream the agent stopped reading), false for a network or server failure.
   */
  error(err: Error, byConsumer: boolean): void;
}

/** The controller of the controller-style API, as far as a handler may use it. */
interface Controller {
  abort(reason?: Error): void;
  pause(): void;
  resume(): void;
  readonly aborted: boolean;
  readonly paused: boolean;
  readonly reason: Error | null;
}

/**
 * Reports whether a handler speaks the controller-style API.
 *
 * @param handler - An undici handler.
 * @returns True when it has `onRequestStart`.
 */
function usesControllerApi(handler: object): boolean {
  return typeof (handler as Loose).onRequestStart === "function";
}

/**
 * Joins header values that undici may hand over as arrays.
 *
 * @param value - A header value.
 * @returns A single string, repeated values joined by ", ".
 */
function joinValue(value: string | string[] | Buffer | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? "" : String(value);
}

/**
 * Converts a flat `[name, value, name, value, ...]` list to a record with
 * lowercase names. Repeated names are joined by ", ".
 *
 * @param raw - Header names and values as buffers or strings.
 * @returns The headers as a record.
 */
function fromRawHeaders(raw: readonly (Buffer | string)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase();
    const value = String(raw[i + 1]);
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

/**
 * Converts the header object of the controller-style API to a record with
 * lowercase names.
 *
 * @param headers - Header names to string or string-array values.
 * @returns The headers as a record.
 */
function fromHeaderObject(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), joinValue(value)]),
  );
}

/**
 * Wraps an undici handler so a response can be delivered to it with plain
 * method calls, whichever API it speaks.
 *
 * @param handler - The handler undici passed to `dispatch`.
 * @returns A sink that delivers to it.
 */
export function toSink(handler: object): ResponseSink {
  const h = handler as Loose;
  if (usesControllerApi(handler)) {
    let controller: object = {};
    return {
      start(abort) {
        controller = {
          abort,
          pause() {},
          resume() {},
          paused: false,
          aborted: false,
          reason: null,
        };
        h.onRequestStart?.(controller, {});
      },
      headers(status, headers, statusText) {
        h.onResponseStart?.(controller, status, headers, statusText);
        return true;
      },
      data(chunk) {
        h.onResponseData?.(controller, chunk);
        return true;
      },
      end() {
        h.onResponseEnd?.(controller, {});
      },
      error(err) {
        h.onResponseError?.(controller, err);
      },
    };
  }
  return {
    start(abort) {
      h.onConnect?.(abort, {});
    },
    headers(status, headers, statusText) {
      const raw = Object.entries(headers).flatMap(([name, value]) => [
        Buffer.from(name),
        Buffer.from(value),
      ]);
      return h.onHeaders?.(status, raw, () => {}, statusText) !== false;
    },
    data(chunk) {
      return h.onData?.(chunk) !== false;
    },
    end() {
      h.onComplete?.([]);
    },
    error(err) {
      h.onError?.(err);
    },
  };
}

/**
 * Builds a handler that passes everything through to `handler` and also
 * tells `observer` what went by. It speaks the same API as `handler`:
 * undici decides how to call a handler by looking at its method names, so a
 * handler with both families would send responses to methods the inner
 * handler does not have.
 *
 * @param handler - The handler undici passed to `dispatch`.
 * @param observer - Receives a copy of the response.
 * @returns A handler to give to the real dispatcher in place of `handler`.
 */
export function teeHandler(handler: object, observer: TeeObserver): object {
  const inner = handler as Loose;
  /**
   * Calls the same-named method of the inner handler, if it has one.
   *
   * @param name - Method name.
   * @param args - Arguments undici passed.
   * @returns What the inner method returned.
   */
  const forward = (name: string, args: unknown[]): unknown => inner[name]?.apply(handler, args);
  // The abort function handed to the inner handler is wrapped, so an error
  // that follows a call to it is known to come from the consumer.
  let byConsumer = false;
  const tee: Record<string | symbol, unknown> = { [HANDLED]: true };
  const controllerApi = usesControllerApi(handler);
  // Callbacks that only pass through. Only the names of the API in use are
  // added: undici takes a handler with `onRequestStart` for a controller-style
  // one, so a legacy tee must not have it.
  const passThrough = controllerApi
    ? ["onRequestUpgrade", "onBodySent"]
    : ["onUpgrade", "onBodySent", "onRequestSent", "onResponseStarted"];
  for (const name of passThrough) {
    tee[name] = (...args: unknown[]) => forward(name, args);
  }
  if (controllerApi) {
    tee.onRequestStart = (...args: unknown[]) => {
      const controller = args[0] as Controller;
      // An object, not a Proxy: undici's controllers keep their state in
      // private fields, which a Proxy receiver cannot read.
      const wrapped: Controller = {
        abort(reason) {
          byConsumer = true;
          controller.abort(reason);
        },
        pause: () => controller.pause(),
        resume: () => controller.resume(),
        get aborted() {
          return controller.aborted;
        },
        get paused() {
          return controller.paused;
        },
        get reason() {
          return controller.reason;
        },
      };
      return forward("onRequestStart", [wrapped, ...args.slice(1)]);
    };
    tee.onResponseStart = (...args: unknown[]) => {
      const [, status, headers] = args as [unknown, number, Record<string, string | string[]>];
      observer.headers(status, fromHeaderObject(headers));
      return forward("onResponseStart", args);
    };
    tee.onResponseData = (...args: unknown[]) => {
      observer.data(Buffer.from(args[1] as Uint8Array));
      return forward("onResponseData", args);
    };
    tee.onResponseEnd = (...args: unknown[]) => {
      observer.end();
      return forward("onResponseEnd", args);
    };
    tee.onResponseError = (...args: unknown[]) => {
      observer.error(args[1] as Error, byConsumer);
      return forward("onResponseError", args);
    };
  } else {
    tee.onConnect = (...args: unknown[]) => {
      const abort = args[0] as (reason?: Error) => void;
      /**
       * The abort function the inner handler gets: notes the abort, then aborts.
       *
       * @param reason - Why the consumer aborted.
       */
      const wrapped = (reason?: Error) => {
        byConsumer = true;
        abort(reason);
      };
      return forward("onConnect", [wrapped, ...args.slice(1)]);
    };
    tee.onHeaders = (...args: unknown[]) => {
      const [status, raw] = args as [number, (Buffer | string)[]];
      observer.headers(status, fromRawHeaders(raw));
      return forward("onHeaders", args);
    };
    tee.onData = (...args: unknown[]) => {
      observer.data(Buffer.from(args[0] as Uint8Array));
      return forward("onData", args);
    };
    tee.onComplete = (...args: unknown[]) => {
      observer.end();
      return forward("onComplete", args);
    };
    tee.onError = (...args: unknown[]) => {
      observer.error(args[0] as Error, byConsumer);
      return forward("onError", args);
    };
  }
  return tee;
}

/**
 * Delivers a recorded response to a sink the way a socket would: headers on
 * one tick, then each chunk on its own tick, then the end.
 *
 * `setImmediate` runs after pending I/O callbacks, so each chunk becomes a
 * separate read for the SDK, as it would be live. `process.nextTick` would
 * run all chunks before any I/O and starve the event loop.
 *
 * @param sink - Where to deliver the response.
 * @param encoded - The response from `encodeResponse`.
 */
export function playResponse(sink: ResponseSink, encoded: ReturnType<typeof encodeResponse>): void {
  let stopped = false;
  const abort = (reason?: Error) => {
    if (stopped) return;
    stopped = true;
    sink.error(reason ?? new DOMException("This operation was aborted", "AbortError"));
  };
  sink.start(abort);
  let next = 0;
  const step = () => {
    if (stopped) return;
    const chunk = encoded.chunks[next++];
    if (chunk === undefined) {
      stopped = true;
      sink.end();
      return;
    }
    sink.data(chunk);
    setImmediate(step);
  };
  setImmediate(() => {
    if (stopped) return;
    sink.headers(encoded.status, encoded.headers, STATUS_CODES[encoded.status] ?? "");
    setImmediate(step);
  });
}
