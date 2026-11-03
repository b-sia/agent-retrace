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

test("priority keys come first, the rest sort as strings; otherwise it writes what JSON.stringify does", () => {
  // biome-ignore lint/suspicious/noSparseArray: the hole is what is under test
  const sparse = [3, 1, , 2];
  expect(
    stableStringify({
      zeta: sparse,
      body: {},
      "10": 1,
      "2": 2,
      alpha: undefined,
      method: "POST",
      b: [],
    }),
  ).toBe(
    `{
  "method": "POST",
  "body": {},
  "10": 1,
  "2": 2,
  "b": [],
  "zeta": [
    3,
    1,
    null,
    2
  ]
}
`,
  );
  // Holes become null at the top level too, as JSON.stringify writes them.
  for (const top of [sparse, new Array(2)]) {
    expect(stableStringify(top)).toBe(`${JSON.stringify(top, null, 2)}\n`);
  }
  expect(stableStringify(new Array(2))).toBe("[\n  null,\n  null\n]\n");
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
