/**
 * The public entry points: `replay()` runs a test body inside a session, and
 * `recordTool()` wraps a tool so its calls become steps of that session.
 */
import { resolve } from "node:path";
import { getConfig, type Mode, resolveMode } from "./config.js";
import { detectRunner, rerecordCommand, runCommand } from "./diff/command.js";
import { RecordingNotFoundError, ReplayUsageError } from "./errors.js";
import { installInterceptor } from "./http/interceptor.js";
import { toJsonArgs, toJsonValue } from "./match/normalize.js";
import type { JsonValue, ToolOutcome } from "./recording/format.js";
import {
  callerTestFile,
  loadRecording,
  recordingPath,
  recordingsDirFor,
  saveRecording,
  validateRecordingName,
} from "./recording/store.js";
import { runtime } from "./runtime.js";
import { Session, type Strategy } from "./session.js";

/** Options accepted by `replay()`. */
export interface ReplayOptions {
  /** Recordings directory, overriding `__recordings__` next to the test file. Relative paths resolve against the working directory. */
  dir?: string;
}

/** Options accepted by `recordTool()`. */
export interface RecordToolOptions<A extends unknown[]> {
  /**
   * Picks the arguments that are matched and stored, e.g. to leave out a
   * logger or client handle. The tool itself still receives all of its
   * arguments. Only called inside `replay()`.
   */
  args?: (...args: A) => unknown[];
}

/**
 * Chooses how a session treats its recording.
 *
 * @param mode - The resolved mode.
 * @param hasRecording - Whether the recording file exists.
 * @returns The session strategy.
 */
function strategyFor(mode: Mode, hasRecording: boolean): Strategy {
  if (!hasRecording) return "record";
  return mode === "update" ? "update" : "strict";
}

/**
 * Runs a test body with its provider calls and wrapped tool calls recorded
 * or replayed, depending on the mode (`AGENT_RETRACE_MODE`, else `replay` on
 * CI and `auto` locally).
 *
 * @param name - Recording name, also the file name: `<dir>/<name>.json`.
 * @param fn - The test body, typically the agent run.
 * @param options - Where recordings live.
 * @returns What `fn` returned.
 * @throws {InvalidRecordingNameError} When the name cannot be used as a file name.
 * @throws {ReplayUsageError} When called inside another `replay()`, when the
 *   same recording is already in use, or when the test file cannot be found and no `dir` is given.
 * @throws {RecordingNotFoundError} In `replay` mode when the recording does not exist.
 * @throws {ChangeDetectedError} When the agent's calls differ from the recording.
 * @throws The error `fn` threw, when nothing changed.
 */
export async function replay<T>(
  name: string,
  fn: () => T | Promise<T>,
  options: ReplayOptions = {},
): Promise<Awaited<T>> {
  // Everything up to the first `await` runs synchronously in the caller's
  // stack, which is what `callerTestFile()` reads, and before a concurrent
  // call can claim the same path.
  validateRecordingName(name);
  const testFile = callerTestFile();
  let dir: string;
  if (options.dir !== undefined) dir = resolve(options.dir);
  else if (testFile !== undefined) dir = recordingsDirFor(testFile);
  else {
    throw new ReplayUsageError(
      `replay(${JSON.stringify(name)}) could not find the test file that called it. Pass { dir } to say where recordings live.`,
    );
  }
  const rt = runtime();
  const outer = rt.als.getStore();
  if (outer !== undefined) {
    throw new ReplayUsageError(
      `replay(${JSON.stringify(name)}) cannot be nested inside replay(${JSON.stringify(outer.name)}). Use one replay() per test.`,
    );
  }
  const path = recordingPath(dir, name);
  if (rt.activePaths.has(path)) {
    throw new ReplayUsageError(
      `Recording ${path} is already in use by another running replay(). Give each concurrent test its own recording name.`,
    );
  }
  rt.activePaths.add(path);
  try {
    // Something may have replaced the global dispatcher since import (a mock
    // agent, a proxy agent); wrapping it again keeps provider calls covered.
    installInterceptor();
    const mode = resolveMode();
    const runner = detectRunner();
    const cwd = process.cwd();
    const recording = await loadRecording(path, name);
    if (mode === "replay" && recording === undefined) {
      throw new RecordingNotFoundError(name, path, runCommand(runner, testFile, cwd));
    }
    const session = new Session({
      name,
      recordingPath: path,
      strategy: strategyFor(mode, recording !== undefined),
      recording,
      command: rerecordCommand(runner, testFile, cwd),
      config: getConfig(),
      save: (r) => saveRecording(path, r),
    });
    let result: Awaited<T> | undefined;
    let fnError: { error: unknown } | undefined;
    try {
      result = await rt.als.run(session, fn);
    } catch (error) {
      fnError = { error };
    }
    await session.finish(fnError);
    return result as Awaited<T>;
  } finally {
    rt.activePaths.delete(path);
  }
}

/**
 * Converts a tool's arguments to the JSON that is matched and stored.
 *
 * @param name - Tool name, for error messages.
 * @param args - The arguments the tool was called with.
 * @param pick - The `args` option, if given.
 * @returns The JSON arguments.
 * @throws {ReplayUsageError} When an argument cannot be stored as JSON.
 */
function jsonArgsOf<A extends unknown[]>(
  name: string,
  args: A,
  pick: ((...args: A) => unknown[]) | undefined,
): JsonValue[] {
  if (pick) return toJsonArgs(pick(...args));
  try {
    return toJsonArgs(args);
  } catch (err) {
    if (!(err instanceof ReplayUsageError)) throw err;
    throw new ReplayUsageError(
      `Tool ${JSON.stringify(name)}: ${err.message} To leave an argument out of matching and the recording, pass recordTool(name, fn, { args }) returning the arguments to keep.`,
      { cause: err },
    );
  }
}

/**
 * Describes how a tool call threw, for the recording.
 *
 * @param err - What the tool threw.
 * @returns A `throw` outcome.
 */
function throwOutcome(err: unknown): ToolOutcome {
  return err instanceof Error
    ? { type: "throw", name: err.name, message: err.message }
    : { type: "throw", name: "Error", message: String(err) };
}

/**
 * Describes what a tool call returned, for the recording.
 *
 * @param name - Tool name, for error messages.
 * @param value - The returned value.
 * @returns A `return` outcome; `undefined` is stored as no value.
 * @throws {ReplayUsageError} When the value cannot be stored as JSON.
 */
function returnOutcome(name: string, value: unknown): ToolOutcome {
  if (value === undefined) return { type: "return" };
  try {
    return { type: "return", value: toJsonValue(value, "result") };
  } catch (err) {
    if (!(err instanceof ReplayUsageError)) throw err;
    throw new ReplayUsageError(
      `Tool ${JSON.stringify(name)} returned a value that cannot be recorded: ${err.message}`,
      { cause: err },
    );
  }
}

/**
 * Wraps a tool so its calls inside `replay()` are recorded and replayed like
 * provider calls. Outside `replay()` the wrapper just calls the tool. The
 * wrapper is always async, even when the tool is not.
 *
 * On replay the tool does not run: it returns the recorded value (a JSON
 * copy, so a `Date` comes back as its ISO string), or throws an `Error` with
 * the recorded `name` and `message`.
 *
 * A tool that runs live is one step: the provider calls and wrapped tools it
 * calls itself go through unrecorded, because on replay the tool does not
 * run and would not make them.
 *
 * @param name - Tool name, shown in change reports and stored in the recording.
 * @param fn - The tool implementation.
 * @param options - Which arguments are matched and stored.
 * @returns The wrapped tool.
 */
export function recordTool<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => R | Promise<R>,
  options: RecordToolOptions<A> = {},
): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    const rt = runtime();
    const session = rt.als.getStore();
    if (session === undefined) return await fn(...args);
    const jsonArgs = jsonArgsOf(name, args, options.args);
    const decision = session.decideTool(name, jsonArgs);
    if (decision.kind === "fail") throw decision.error;
    if (decision.kind === "replay") {
      const { outcome } = decision.step;
      if (outcome.type === "throw") {
        const error = new Error(outcome.message);
        error.name = outcome.name;
        throw error;
      }
      // A copy, so a caller that mutates the result cannot change the recording.
      return structuredClone(outcome.value) as Awaited<R>;
    }
    let value: Awaited<R>;
    try {
      // Cleared, not exited: `als.exit` is still experimental in Node 22.
      value = await rt.als.run(undefined, () => fn(...args));
    } catch (err) {
      decision.commit({ type: "tool", name, args: jsonArgs, outcome: throwOutcome(err) });
      throw err;
    }
    let outcome: ToolOutcome;
    try {
      outcome = returnOutcome(name, value);
    } catch (err) {
      decision.commit(undefined);
      throw err;
    }
    decision.commit({ type: "tool", name, args: jsonArgs, outcome });
    return value;
  };
}
