/**
 * Tests for server-sent event parsing and serialization.
 */
import { expect, test } from "vitest";
import { parseSse, serializeSse } from "../../src/http/sse.js";

test("parse/serialize SSE round trip", () => {
  const raw = 'event: message_start\ndata: {"a":1}\n\ndata: [DONE]\n\n';
  expect(parseSse(raw)).toEqual([{ event: "message_start", data: { a: 1 } }, { text: "[DONE]" }]);
  expect(parseSse(serializeSse(parseSse(raw)).join(""))).toEqual(parseSse(raw));
});

test("CRLF and multi-line data", () => {
  expect(parseSse("data: a\r\ndata: b\r\n\r\n")).toEqual([{ text: "a\nb" }]);
});

test("comments, id and retry lines are ignored", () => {
  const raw = ": keep-alive\n\nid: 7\nretry: 100\nevent: ping\ndata: 1\n\n";
  expect(parseSse(raw)).toEqual([{ event: "ping", data: 1 }]);
});

test("a trailing event without a blank line is still parsed", () => {
  expect(parseSse("data: tail")).toEqual([{ text: "tail" }]);
});

test("serializes one chunk per event", () => {
  const chunks = serializeSse([{ event: "x", data: { a: 1 } }, { text: "[DONE]" }]);
  expect(chunks).toEqual(['event: x\ndata: {"a":1}\n\n', "data: [DONE]\n\n"]);
});
