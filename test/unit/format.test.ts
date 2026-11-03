/**
 * Tests for the recording format: stable serialization and validated parsing.
 */
import { expect, test } from "vitest";
import { RecordingFormatError } from "../../src/errors.js";
import {
  parseRecording,
  type Recording,
  serializeRecording,
  stableStringify,
  stableStringifyLine,
} from "../../src/recording/format.js";

const sample: Recording = {
  formatVersion: 1,
  name: "refund-damaged-order",
  steps: [
    {
      type: "llm",
      request: {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        headers: { "content-type": "application/json" },
        body: { model: "gpt-x", messages: [{ role: "user", content: "hi" }] },
      },
      response: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        events: [{ data: { delta: "he" } }, { event: "done", text: "[DONE]" }],
      },
    },
    {
      type: "tool",
      name: "lookupOrder",
      args: ["A-1", { deep: true }],
      outcome: { type: "return" },
    },
    {
      type: "tool",
      name: "refund",
      args: [],
      outcome: { type: "throw", name: "Error", message: "declined" },
    },
    {
      type: "tool",
      name: "charge",
      args: [],
      outcome: {
        type: "throw",
        name: "HttpError",
        message: "payment failed",
        props: { status: 402, retryable: false, code: "card_declined", detail: null },
        cause: { name: "RangeError", message: "card expired" },
      },
    },
  ],
};

test("stable key order and formatting", () => {
  const r = {
    steps: [
      { type: "tool", outcome: { type: "return", value: { z: 1, a: 2 } }, args: [], name: "s" },
    ],
    name: "n",
    formatVersion: 1,
  } as Recording;
  expect(serializeRecording(r)).toBe(
    `{
  "formatVersion": 1,
  "name": "n",
  "steps": [
    {
      "name": "s",
      "type": "tool",
      "args": [],
      "outcome": {
        "type": "return",
        "value": {
          "a": 2,
          "z": 1
        }
      }
    }
  ]
}
`,
  );
});

test("priority keys come first, the rest alphabetically", () => {
  expect(stableStringify({ zeta: 1, body: 2, alpha: 3, method: 4 })).toBe(
    `{\n  "method": 4,\n  "body": 2,\n  "alpha": 3,\n  "zeta": 1\n}\n`,
  );
});

test("integer-like keys sort as strings, not numerically first", () => {
  expect(stableStringify({ b: 1, "10": 2, "2": 3 })).toBe(
    `{\n  "10": 2,\n  "2": 3,\n  "b": 1\n}\n`,
  );
});

test("stableStringifyLine writes one line in the same key order", () => {
  const value = {
    zeta: [1, { b: null, a: "x\ny" }],
    "10": true,
    method: "POST",
    empty: {},
    none: [],
  };
  expect(stableStringifyLine(value)).toBe(
    '{"method":"POST","10":true,"empty":{},"none":[],"zeta":[1,{"a":"x\\ny","b":null}]}',
  );
  expect(JSON.parse(stableStringifyLine(value))).toEqual(JSON.parse(stableStringify(value)));
  expect(stableStringifyLine("s")).toBe('"s"');
});

test("circular structures throw", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  expect(() => stableStringify(a)).toThrow(TypeError);
});

test("arrays keep their order and empty containers stay inline", () => {
  expect(stableStringify({ a: [3, 1, 2], b: {} })).toBe(
    `{\n  "a": [\n    3,\n    1,\n    2\n  ],\n  "b": {}\n}\n`,
  );
});

test("undefined properties are dropped like JSON.stringify", () => {
  expect(stableStringify({ a: undefined, b: 1 })).toBe(`{\n  "b": 1\n}\n`);
});

test("holes in sparse arrays are written as null like JSON.stringify", () => {
  // biome-ignore lint/suspicious/noSparseArray: the hole is what is under test
  const sparse = [1, , 3];
  expect(stableStringify(sparse)).toBe(`${JSON.stringify(sparse, null, 2)}\n`);
  expect(stableStringify(new Array(2))).toBe("[\n  null,\n  null\n]\n");
});

test("round trip", () => expect(parseRecording(serializeRecording(sample), "f")).toEqual(sample));

test.each([
  ["not json"],
  ['{"name":"n","steps":[]}'],
  ['{"formatVersion":1.5,"name":"n","steps":[]}'],
  ['{"formatVersion":"1","name":"n","steps":[]}'],
  ['{"formatVersion":2,"name":"n","steps":[]}'],
  ['{"formatVersion":1,"name":"n","steps":[{"type":"x"}]}'],
  ['{"formatVersion":1,"name":"n","steps":[null]}'],
  ['{"formatVersion":1,"name":"n","steps":{}}'],
  ['{"formatVersion":1,"steps":[]}'],
  ["[]"],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{},"text":5},"response":{"status":200,"headers":{},"body":{}}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{},"text":5}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{}}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{},"body":1,"text":"x"}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{},"text":"x","events":[]}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{},"events":[null]}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{},"events":[7]}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{},"events":[{"event":1}]}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"llm","request":{"method":"POST","url":"u","headers":{}},"response":{"status":200,"headers":{},"events":[{"text":1}]}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"tool","name":"t","args":[],"outcome":{"type":"throw","name":"E","message":"m","props":[]}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"tool","name":"t","args":[],"outcome":{"type":"throw","name":"E","message":"m","props":{"a":{}}}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"tool","name":"t","args":[],"outcome":{"type":"throw","name":"E","message":"m","cause":"x"}}]}',
  ],
  [
    '{"formatVersion":1,"name":"n","steps":[{"type":"tool","name":"t","args":[],"outcome":{"type":"throw","name":"E","message":"m","cause":{"name":"C"}}}]}',
  ],
])("rejects %s", (t) => expect(() => parseRecording(t, "f.json")).toThrow(RecordingFormatError));

test("newer version message", () =>
  expect(() => parseRecording('{"formatVersion":2,"name":"n","steps":[]}', "f")).toThrow(
    /upgrade/,
  ));

test("the error names the file", () =>
  expect(() => parseRecording("not json", "/x/f.json")).toThrow(/\/x\/f\.json/));

test("a step type with terminal control characters is escaped in the error", () => {
  const text = JSON.stringify({ formatVersion: 1, name: "x", steps: [{ type: "\u009b2J\u001b" }] });
  expect(() => parseRecording(text, "/r.json")).toThrow(
    'Invalid recording file /r.json: step 1 has unknown type "\\u009b2J\\u001b"',
  );
});
