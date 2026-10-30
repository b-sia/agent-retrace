/**
 * Tests for the undici handler adapters, with hand-written handlers for both
 * the legacy callback API and the newer controller API.
 */
import { expect, test } from "vitest";
import { encodeResponse } from "../../src/http/capture.js";
import { playResponse, teeHandler, toSink } from "../../src/http/handler.js";

const encoded = encodeResponse({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  events: [{ data: 1 }, { data: 2 }],
});

/** A legacy-API handler that logs every call. */
function legacyHandler() {
  const calls: unknown[][] = [];
  const handler = {
    onConnect: (...a: unknown[]) => void calls.push(["onConnect", typeof a[0]]),
    onHeaders: (status: number, raw: Buffer[], _resume: unknown, text: string) => {
      calls.push(["onHeaders", status, raw.map(String), text]);
      return true;
    },
    onData: (chunk: Buffer) => {
      calls.push(["onData", chunk.toString()]);
      return true;
    },
    onComplete: (trailers: unknown) => void calls.push(["onComplete", trailers]),
    onError: (err: Error) => void calls.push(["onError", err.name]),
  };
  return { handler, calls };
}

/** A new-API handler that logs every call. */
function modernHandler() {
  const calls: unknown[][] = [];
  const handler: { onRequestStart: (c: { abort(r?: Error): void }) => void; [k: string]: unknown } =
    {
      onRequestStart: (c) => void calls.push(["onRequestStart", typeof c.abort]),
      onResponseStart: (
        _c: unknown,
        status: number,
        headers: Record<string, string>,
        text: string,
      ) => void calls.push(["onResponseStart", status, headers, text]),
      onResponseData: (_c: unknown, chunk: Buffer) =>
        void calls.push(["onResponseData", chunk.toString()]),
      onResponseEnd: (_c: unknown, trailers: unknown) =>
        void calls.push(["onResponseEnd", trailers]),
      onResponseError: (_c: unknown, err: Error) => void calls.push(["onResponseError", err.name]),
    };
  return { handler, calls };
}

/** Waits for the replay to finish, i.e. for `end` or `error` to be called. */
function finished(calls: unknown[][]): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (
        calls.some((c) =>
          ["onComplete", "onResponseEnd", "onError", "onResponseError"].includes(c[0] as string),
        )
      ) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
}

test("playResponse drives a legacy handler: connect, headers, one data call per chunk, complete", async () => {
  const { handler, calls } = legacyHandler();
  playResponse(toSink(handler), encoded);
  await finished(calls);
  expect(calls).toEqual([
    ["onConnect", "function"],
    ["onHeaders", 200, ["content-type", "text/event-stream"], "OK"],
    ["onData", "data: 1\n\n"],
    ["onData", "data: 2\n\n"],
    ["onComplete", []],
  ]);
});

test("playResponse drives a new-API handler", async () => {
  const { handler, calls } = modernHandler();
  playResponse(toSink(handler), encoded);
  await finished(calls);
  expect(calls).toEqual([
    ["onRequestStart", "function"],
    ["onResponseStart", 200, { "content-type": "text/event-stream" }, "OK"],
    ["onResponseData", "data: 1\n\n"],
    ["onResponseData", "data: 2\n\n"],
    ["onResponseEnd", {}],
  ]);
});

test("aborting a legacy handler stops playback and reports an AbortError", async () => {
  const { handler, calls } = legacyHandler();
  let abort: ((reason?: Error) => void) | undefined;
  handler.onConnect = (a: unknown) => {
    abort = a as (reason?: Error) => void;
  };
  handler.onHeaders = (...args: [number, Buffer[], unknown, string]) => {
    calls.push(["onHeaders", args[0]]);
    abort?.();
    return true;
  };
  playResponse(toSink(handler), encoded);
  await finished(calls);
  expect(calls).toEqual([
    ["onHeaders", 200],
    ["onError", "AbortError"],
  ]);
});

test("aborting a new-API handler passes the given reason", async () => {
  const { handler, calls } = modernHandler();
  const reason = new Error("stop");
  reason.name = "Stop";
  handler.onRequestStart = (c: { abort(r?: Error): void }) => c.abort(reason);
  playResponse(toSink(handler), encoded);
  await finished(calls);
  expect(calls).toEqual([["onResponseError", "Stop"]]);
});

test("teeHandler observes a legacy response and forwards every call", () => {
  const { handler, calls } = legacyHandler();
  const seen: unknown[][] = [];
  const tee = teeHandler(handler, {
    headers: (status, headers) => seen.push(["headers", status, headers]),
    data: (chunk) => seen.push(["data", chunk.toString()]),
    end: () => seen.push(["end"]),
    error: (err) => seen.push(["error", err.name]),
  }) as Record<string, (...args: unknown[]) => unknown>;
  tee.onConnect?.(() => {}, {});
  expect(
    tee.onHeaders?.(200, [Buffer.from("Content-Type"), Buffer.from("text/plain")], () => {}, "OK"),
  ).toBe(true);
  expect(tee.onData?.(Buffer.from("hi"))).toBe(true);
  tee.onComplete?.([]);
  expect(seen).toEqual([
    ["headers", 200, { "content-type": "text/plain" }],
    ["data", "hi"],
    ["end"],
  ]);
  expect(calls.map((c) => c[0])).toEqual(["onConnect", "onHeaders", "onData", "onComplete"]);
  expect(tee.onResponseStart).toBeUndefined();
});

test("teeHandler observes a new-API response and forwards every call", () => {
  const { handler, calls } = modernHandler();
  const seen: unknown[][] = [];
  const tee = teeHandler(handler, {
    headers: (status, headers) => seen.push(["headers", status, headers]),
    data: (chunk) => seen.push(["data", chunk.toString()]),
    end: () => seen.push(["end"]),
    error: (err) => seen.push(["error", err.name]),
  }) as Record<string, (...args: unknown[]) => unknown>;
  const controller = { abort() {} };
  tee.onRequestStart?.(controller, {});
  tee.onResponseStart?.(controller, 201, { "content-type": ["a", "b"] }, "Created");
  tee.onResponseData?.(controller, Buffer.from("hi"));
  tee.onResponseError?.(controller, new Error("x"));
  expect(seen).toEqual([
    ["headers", 201, { "content-type": "a, b" }],
    ["data", "hi"],
    ["error", "Error"],
  ]);
  expect(calls.map((c) => c[0])).toEqual([
    "onRequestStart",
    "onResponseStart",
    "onResponseData",
    "onResponseError",
  ]);
  expect(tee.onHeaders).toBeUndefined();
});
