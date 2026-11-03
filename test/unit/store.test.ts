/**
 * Tests for recording names, paths, caller detection and the file store.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { InvalidRecordingNameError, RecordingFormatError } from "../../src/errors.js";
import type { Recording } from "../../src/recording/format.js";
import {
  callerTestFile,
  loadRecording,
  recordingPath,
  recordingsDirFor,
  saveRecording,
  validateRecordingName,
} from "../../src/recording/store.js";

const sample: Recording = {
  formatVersion: 1,
  name: "refund-damaged-order",
  steps: [{ type: "tool", name: "lookup", args: ["A-1"], outcome: { type: "return", value: 1 } }],
};

let tmp: string;
let p: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-retrace-store-"));
  p = join(tmp, "__recordings__", `${sample.name}.json`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test.each([
  "",
  "../x",
  "a/b",
  "a\\b",
  ".hidden",
  "x.",
  "x ",
  "-x",
  "a:b",
  "x".repeat(121),
  "con",
  "NUL.case",
  "com1 ",
])("invalid name %j", (n) =>
  expect(() => validateRecordingName(n)).toThrow(InvalidRecordingNameError),
);
test.each(["refund-damaged-order", "Refund 2", "v1.2_case", "x".repeat(120), "console", "com10"])(
  "valid name %j",
  (n) => expect(() => validateRecordingName(n)).not.toThrow(),
);

test("recordings dir sits next to the test file", () =>
  expect(recordingsDirFor("/a/b/agent.test.ts")).toBe("/a/b/__recordings__"));
test("recording path appends .json", () =>
  expect(recordingPath("/a/__recordings__", "Refund 2")).toBe("/a/__recordings__/Refund 2.json"));

test("callerTestFile returns this test file", () =>
  expect(callerTestFile()).toBe(fileURLToPath(import.meta.url)));

test("callerTestFile restores Error.prepareStackTrace", () => {
  const before = Error.prepareStackTrace;
  callerTestFile();
  expect(Error.prepareStackTrace).toBe(before);
});

test("load missing returns undefined", async () =>
  expect(await loadRecording(join(tmp, "nope.json"), "nope")).toBeUndefined());

test("save then load", async () => {
  await saveRecording(p, sample);
  expect(await loadRecording(p, sample.name)).toEqual(sample);
});

test("save leaves no tmp files", async () => {
  await saveRecording(p, sample);
  expect(readdirSync(dirname(p))).toEqual([basename(p)]);
});

test("save overwrites an existing recording", async () => {
  await saveRecording(p, sample);
  const updated: Recording = { ...sample, steps: [] };
  await saveRecording(p, updated);
  expect(await loadRecording(p, sample.name)).toEqual(updated);
});

test("name mismatch in file is an error", async () => {
  await saveRecording(p, { ...sample, name: "Other" });
  await expect(loadRecording(p, sample.name)).rejects.toThrow(RecordingFormatError);
});

test("a corrupt file is a format error naming the path", async () => {
  writeFileSync(join(tmp, "bad.json"), "{");
  await expect(loadRecording(join(tmp, "bad.json"), "bad")).rejects.toThrow(
    new RegExp(`${join(tmp, "bad.json")}`),
  );
});
