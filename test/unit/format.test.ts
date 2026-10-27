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
])("rejects %s", (t) => expect(() => parseRecording(t, "f.json")).toThrow(RecordingFormatError));

test("newer version message", () =>
  expect(() => parseRecording('{"formatVersion":2,"name":"n","steps":[]}', "f")).toThrow(
    /upgrade/,
  ));

test("the error names the file", () =>
  expect(() => parseRecording("not json", "/x/f.json")).toThrow(/\/x\/f\.json/));
