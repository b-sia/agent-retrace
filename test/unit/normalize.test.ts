/**
 * Tests for request normalization: redaction, secret scrubbing, ignore paths,
 * match keys and tool argument conversion.
 */
import { expect, test } from "vitest";
import { getConfig } from "../../src/config.js";
import { ReplayUsageError } from "../../src/errors.js";
import {
  llmMatchKey,
  REDACTED,
  redactDeep,
  removeIgnoredPaths,
  scrubSecrets,
  secretsFromHeaders,
  toJsonArgs,
  toJsonValue,
  toolMatchKey,
} from "../../src/match/normalize.js";
import type { RecordedRequest } from "../../src/recording/format.js";

test("regex redaction everywhere", () =>
  expect(redactDeep({ a: ["call 555-1234"], b: "555-1234" }, [/\d{3}-\d{4}/])).toEqual({
    a: ["call [REDACTED]"],
    b: "[REDACTED]",
  }));

test("regex redaction replaces every match without the g flag", () =>
  expect(redactDeep("555-1234 or 555-9876", [/\d{3}-\d{4}/])).toBe("[REDACTED] or [REDACTED]"));

test("a g-flagged rule is reusable and left untouched", () => {
  const rule = /sk-[a-z]+/g;
  expect(redactDeep(["sk-abc", "sk-def"], [rule])).toEqual([REDACTED, REDACTED]);
  expect(redactDeep("sk-ghi", [rule])).toBe(REDACTED);
  expect(rule.lastIndex).toBe(0);
});

test("a sticky rule still redacts every match, anywhere in the string", () => {
  const rule = /\d{3}-\d{4}/y;
  expect(redactDeep("x 555-1234 and 555-9999", [rule])).toBe("x [REDACTED] and [REDACTED]");
  expect(rule.flags).toBe("y");
});

test("function redaction", () =>
  expect(redactDeep("Alice", [(s) => s.toUpperCase()])).toBe("ALICE"));

test("redaction rules apply in order and leave keys and non-strings alone", () =>
  expect(
    redactDeep({ "555-1234": 5551234, n: null, t: true, s: "ab" }, [/a/, (s) => `${s}!`]),
  ).toEqual({
    "555-1234": 5551234,
    n: null,
    t: true,
    s: "[REDACTED]b!",
  }));

test("redactDeep does not mutate its input", () => {
  const input = { a: ["x1"] };
  redactDeep(input, [/\d/]);
  expect(input).toEqual({ a: ["x1"] });
});

test("scrub secrets", () =>
  expect(scrubSecrets({ x: "key sk-abcdef123456 here" }, ["sk-abcdef123456"])).toEqual({
    x: "key [REDACTED] here",
  }));

test("short secrets ignored", () => expect(scrubSecrets("abc", ["abc"])).toBe("abc"));

test("scrub replaces every occurrence, in nested values and keys", () =>
  expect(
    scrubSecrets({ list: ["sk-abcdef123456 sk-abcdef123456"], "sk-abcdef123456": 1 }, [
      "sk-abcdef123456",
    ]),
  ).toEqual({ list: ["[REDACTED] [REDACTED]"], "[REDACTED]": 1 }));

test("scrub prefers the longest overlapping secret and does not rescan its output", () =>
  expect(
    scrubSecrets("sk-abcdefgh-extra and REDACTED!", [
      "sk-abcdefgh",
      "sk-abcdefgh-extra",
      "REDACTED",
    ]),
  ).toBe("[REDACTED] and [REDACTED]!"));

test("scrub treats secrets literally, not as patterns", () =>
  expect(scrubSecrets("a.b+c*d?e and axbbcdde", ["a.b+c*d?e"])).toBe("[REDACTED] and axbbcdde"));

test("scrub with no usable secrets returns the value", () => {
  const value = { x: "abc" };
  expect(scrubSecrets(value, [])).toBe(value);
});

test("bearer token extracted", () =>
  expect(secretsFromHeaders({ authorization: "Bearer sk-live-xyz12345" })).toContain(
    "sk-live-xyz12345",
  ));

test("secret headers are read case-insensitively, other headers are not secrets", () =>
  expect(
    secretsFromHeaders({
      Authorization: "Bearer tok-1234567890",
      "X-Api-Key": "key-1234567890",
      "Proxy-Authorization": "Basic dXNlcjpwYXNzd29yZA==",
      Cookie: "session=abc123456789",
      "api-key": "azure-1234567890",
      "content-type": "application/json",
    }),
  ).toEqual([
    "Bearer tok-1234567890",
    "tok-1234567890",
    "key-1234567890",
    "Basic dXNlcjpwYXNzd29yZA==",
    "dXNlcjpwYXNzd29yZA==",
    "session=abc123456789",
    "azure-1234567890",
  ]));

test("secretsFromHeaders skips empty values and dedupes", () =>
  expect(
    secretsFromHeaders({ authorization: "  ", "x-api-key": "k-12345678", "api-key": "k-12345678" }),
  ).toEqual(["k-12345678"]));

test("ignore paths with wildcard", () =>
  expect(
    removeIgnoredPaths({ messages: [{ c: 1, cache_control: 2 }, { c: 3 }], m: 1 }, [
      "messages.*.cache_control",
      "nope.x",
    ]),
  ).toEqual({ messages: [{ c: 1 }, { c: 3 }], m: 1 }));

test("ignore paths: array index, wildcard over keys, whole subtree", () =>
  expect(
    removeIgnoredPaths({ a: [1, 2, 3], o: { x: { t: 1, k: 2 }, y: { t: 3 } }, gone: { deep: 1 } }, [
      "a.1",
      "o.*.t",
      "gone",
    ]),
  ).toEqual({ a: [1, 3], o: { x: { k: 2 }, y: {} } }));

test("ignore paths that do not fit the value are no-ops", () => {
  const value = { a: [1], s: "str", n: null };
  expect(
    removeIgnoredPaths(value, ["a.5", "a.x", "s.length", "n.x", "a.0.x", "", "missing"]),
  ).toEqual(value);
});

test("removeIgnoredPaths does not mutate its input", () => {
  const input = { messages: [{ c: 1, cache_control: 2 }] };
  removeIgnoredPaths(input, ["messages.*.cache_control"]);
  expect(input).toEqual({ messages: [{ c: 1, cache_control: 2 }] });
});

test("match key ignores key order and configured paths", () => {
  const cfg = { ...getConfig(), ignore: ["metadata"] };
  const a = {
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    body: { model: "m", messages: [], metadata: { t: 1 } },
  };
  const b = { ...a, body: { messages: [], model: "m", metadata: { t: 2 } } };
  expect(llmMatchKey(a, cfg)).toBe(llmMatchKey(b, cfg));
  expect(llmMatchKey(a, cfg)).not.toBe(
    llmMatchKey({ ...a, body: { model: "m2", messages: [] } }, cfg),
  );
});

test("match key covers method, url with query, headers and text bodies", () => {
  const cfg = getConfig();
  const base: RecordedRequest = {
    method: "POST",
    url: "https://x.example/v1/chat?api-version=1",
    headers: { "openai-beta": "a" },
    text: "raw",
  };
  const key = llmMatchKey(base, cfg);
  expect(llmMatchKey({ ...base }, cfg)).toBe(key);
  for (const changed of [
    { ...base, method: "PUT" },
    { ...base, url: "https://x.example/v1/chat?api-version=2" },
    { ...base, headers: { "openai-beta": "b" } },
    { ...base, text: "other" },
  ]) {
    expect(llmMatchKey(changed, cfg)).not.toBe(key);
  }
});

test("match key tells a text body from an equal JSON string body", () => {
  const req: RecordedRequest = { method: "POST", url: "https://x.example/", headers: {} };
  expect(llmMatchKey({ ...req, text: "hi" }, getConfig())).not.toBe(
    llmMatchKey({ ...req, body: "hi" }, getConfig()),
  );
});

test("tool match key covers name and args, not key order", () => {
  expect(toolMatchKey("search", [{ q: "x", n: 1 }])).toBe(
    toolMatchKey("search", [{ n: 1, q: "x" }]),
  );
  expect(toolMatchKey("search", [{ q: "x" }])).not.toBe(toolMatchKey("lookup", [{ q: "x" }]));
  expect(toolMatchKey("search", [{ q: "x" }])).not.toBe(toolMatchKey("search", [{ q: "y" }]));
});

test("toJsonArgs drops AbortSignal and functions", () =>
  expect(
    toJsonArgs([
      { q: "x" },
      { abortSignal: new AbortController().signal, toolCallId: "c1", fn: () => 1 },
    ]),
  ).toEqual([{ q: "x" }, { toolCallId: "c1" }]));

test("toJsonArgs follows JSON.stringify semantics", () => {
  const sym = Symbol("s");
  expect(
    toJsonArgs([
      new Date("2026-01-02T03:04:05.000Z"),
      [1, undefined, () => 1, sym, new AbortController().signal],
      { u: undefined, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, negZero: -0, [sym]: 1 },
      undefined,
      { toJSON: () => ({ custom: true }) },
    ]),
  ).toEqual([
    "2026-01-02T03:04:05.000Z",
    [1, null, null, null, null],
    { nan: null, inf: null, negZero: 0 },
    null,
    { custom: true },
  ]);
  expect(Object.is(toJsonArgs([-0])[0] as number, 0)).toBe(true);
});

test("toJsonArgs keeps shared non-circular references", () => {
  const shared = { v: 1 };
  expect(toJsonArgs([{ a: shared, b: shared }])).toEqual([{ a: { v: 1 }, b: { v: 1 } }]);
});

test("toJsonArgs writes sparse array holes as null", () =>
  // biome-ignore lint/suspicious/noSparseArray: the hole is what is being tested
  expect(toJsonArgs([[1, , 3]])).toEqual([[1, null, 3]]));

test("toJsonArgs rejects circular", () => {
  // biome-ignore lint/suspicious/noExplicitAny: building a cycle needs an untyped object
  const o: any = {};
  o.self = o;
  expect(() => toJsonArgs([o])).toThrow(ReplayUsageError);
  expect(() => toJsonArgs([o])).toThrow(/args\[0\]\.self/);
});

test("toJsonArgs rejects bigint, naming the path", () =>
  expect(() => toJsonArgs(["ok", { items: [{ n: 1n }] }])).toThrow(/args\[1\]\.items\[0\]\.n/));

test.each([
  ["Map", new Map([["a", 1]])],
  ["Set", new Set([1])],
])("toJsonArgs rejects a %s instead of silently writing {}", (_, value) =>
  expect(() => toJsonArgs([{ v: value }])).toThrow(ReplayUsageError),
);

test.each([
  ["an Error", new Error("boom")],
  ["a RegExp", /re/],
  ["a Promise", Promise.resolve(1)],
  ["a WeakMap", new WeakMap()],
  ["a class instance without fields", new (class Empty {})()],
])("toJsonArgs rejects %s, which JSON writes as {}", (_, value) =>
  expect(() => toJsonArgs([{ v: value }])).toThrow(/args\[0\]\.v is a .*JSON writes as \{\}/),
);

test("toJsonArgs keeps empty plain objects and class instances with fields", () =>
  expect(
    toJsonArgs([
      {},
      Object.create(null),
      new (class Point {
        x = 1;
        y = 2;
      })(),
    ]),
  ).toEqual([{}, {}, { x: 1, y: 2 }]));

test("toJsonValue names the given root in errors", () =>
  expect(() => toJsonValue({ n: 1n }, "return value")).toThrow(/return value\.n/));

test("quoted path segments for keys that are not identifiers", () =>
  expect(() => toJsonArgs([{ "a b": 1n }])).toThrow(/args\[0\]\["a b"\]/));
