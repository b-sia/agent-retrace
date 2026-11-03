/**
 * Tests for the error classes.
 */
import { expect, test } from "vitest";
import {
  AgentRetraceError,
  ChangeDetectedError,
  InvalidModeError,
  InvalidRecordingNameError,
  ProviderCallBlockedError,
  RecordingFormatError,
  RecordingNotFoundError,
  ReplayUsageError,
} from "../../src/errors.js";

test.each<[string, AgentRetraceError, Record<string, unknown>]>([
  ["InvalidModeError", new InvalidModeError("x"), { value: "x" }],
  ["InvalidRecordingNameError", new InvalidRecordingNameError("../x"), { recordingName: "../x" }],
  [
    "RecordingFormatError",
    new RecordingFormatError("/r.json", "bad json"),
    { filePath: "/r.json", reason: "bad json" },
  ],
  [
    "RecordingNotFoundError",
    new RecordingNotFoundError("n", "/r.json", "cmd"),
    { recordingName: "n", filePath: "/r.json", command: "cmd" },
  ],
  [
    "ChangeDetectedError",
    new ChangeDetectedError("report", { recordingName: "n", stepNumber: 1, totalSteps: 2 }),
    {},
  ],
  [
    "ProviderCallBlockedError",
    new ProviderCallBlockedError("https://x", "node-http"),
    { url: "https://x", reason: "node-http" },
  ],
  ["ReplayUsageError", new ReplayUsageError("bad"), {}],
])(
  "%s has its class name, extends AgentRetraceError and exposes its inputs",
  (name, err, fields) => {
    expect(err.name).toBe(name);
    expect(err).toBeInstanceOf(AgentRetraceError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject(fields);
  },
);

test("ChangeDetectedError carries the report, step info and cause", () => {
  const cause = new Error("sdk");
  const err = new ChangeDetectedError(
    "Your agent changed at step 2 of 3",
    { recordingName: "flow", stepNumber: 2, totalSteps: 3 },
    { cause },
  );
  expect(err.message).toBe("Your agent changed at step 2 of 3");
  expect(err.recordingName).toBe("flow");
  expect(err.stepNumber).toBe(2);
  expect(err.totalSteps).toBe(3);
  expect(err.cause).toBe(cause);
});
