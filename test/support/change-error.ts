/**
 * Assertions on the error `replay()` rejects with when the agent changed.
 */
import { expect } from "vitest";
import { ChangeDetectedError } from "../../src/index.js";

/**
 * Awaits a run that must fail with a change report, and checks that the
 * report is told once: the error is a `ChangeDetectedError`, its message
 * matches, and it carries no `cause` (a cause here would be the SDK's error
 * for agent-retrace's own refusal, which repeats the report and makes test
 * runners print it two or three times). Its stack must lead to the
 * `replay()` call in the SDK test file, not only to library internals.
 *
 * @param run - The `replay()` promise.
 * @param pattern - What the report must contain.
 * @returns The error, for further checks.
 * @throws {AssertionError} When the run resolves or the error does not match.
 */
export async function expectChangeReport(
  run: Promise<unknown>,
  pattern: RegExp,
): Promise<ChangeDetectedError> {
  const err: unknown = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChangeDetectedError);
  const change = err as ChangeDetectedError;
  expect(change.message).toMatch(pattern);
  expect(change.cause).toBeUndefined();
  // Frames only: the message itself names the test file in its command.
  const frames = (change.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  expect(frames.join("\n")).toMatch(/test\/sdk\/[\w-]+\.test\.ts/);
  return change;
}
