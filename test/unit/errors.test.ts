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

test.each([
  ["InvalidModeError", new InvalidModeError("x")],
  ["InvalidRecordingNameError", new InvalidRecordingNameError("../x")],
  ["RecordingFormatError", new RecordingFormatError("/r.json", "bad json")],
  ["RecordingNotFoundError", new RecordingNotFoundError("n", "/r.json", "cmd")],
  [
    "ChangeDetectedError",
    new ChangeDetectedError("report", { recordingName: "n", stepNumber: 1, totalSteps: 2 }),
  ],
  ["ProviderCallBlockedError", new ProviderCallBlockedError("https://x", "node-http")],
  ["ReplayUsageError", new ReplayUsageError("bad")],
])("%s has its class name and extends AgentRetraceError", (name, err) => {
  expect(err.name).toBe(name);
  expect(err).toBeInstanceOf(AgentRetraceError);
  expect(err).toBeInstanceOf(Error);
});

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

test("errors expose their inputs", () => {
  expect(new InvalidModeError("record").value).toBe("record");
  expect(new InvalidRecordingNameError("../x").recordingName).toBe("../x");
  const fmt = new RecordingFormatError("/r.json", "bad json");
  expect([fmt.filePath, fmt.reason]).toEqual(["/r.json", "bad json"]);
  expect(fmt.message).toContain("/r.json");
  const nf = new RecordingNotFoundError("flow", "/r.json", "AGENT_RETRACE_MODE=auto npx vitest");
  expect([nf.recordingName, nf.filePath, nf.command]).toEqual([
    "flow",
    "/r.json",
    "AGENT_RETRACE_MODE=auto npx vitest",
  ]);
  expect(nf.message).toContain("AGENT_RETRACE_MODE=auto npx vitest");
  const blocked = new ProviderCallBlockedError("https://api.openai.com/v1", "outside-replay");
  expect([blocked.url, blocked.reason]).toEqual(["https://api.openai.com/v1", "outside-replay"]);
  expect(blocked.message).toContain("https://api.openai.com/v1");
});
