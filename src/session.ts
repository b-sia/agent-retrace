/**
 * The per-replay state machine. A `Session` decides, for every provider
 * request and wrapped tool call made inside one `replay()`, whether to serve a
 * recorded step, go live and record the result, or fail with a change report.
 * Pure apart from calling the `save` function it is given, so it is tested
 * without sockets.
 */
import type { AgentRetraceConfig } from "./config.js";
import { type ChangeReport, renderChange } from "./diff/render.js";
import { ChangeDetectedError, ProviderCallBlockedError, ReplayUsageError } from "./errors.js";
import { llmMatchKey, toolMatchKey } from "./match/normalize.js";
import type {
  JsonValue,
  LlmStep,
  RecordedRequest,
  Recording,
  Step,
  ToolStep,
} from "./recording/format.js";

/**
 * How a session treats its recording: `strict` replays and fails on any
 * change, `record` ignores any existing recording and records everything,
 * `update` replays until the first change and records from there.
 */
export type Strategy = "strict" | "record" | "update";

/** Everything a session needs; the caller resolves paths, mode and I/O. */
export interface SessionOptions {
  /** Recording name, as passed to `replay()`. */
  name: string;
  /** Absolute path of the recording file, shown in change reports. */
  recordingPath: string;
  /** How to treat the recording. */
  strategy: Strategy;
  /** The existing recording, if there is one. */
  recording: Recording | undefined;
  /** Shell command that re-records, shown in change reports. */
  command: string;
  /** Configuration supplying the ignore paths used for matching. */
  config: AgentRetraceConfig;
  /** Writes a recording to disk. */
  save(r: Recording): Promise<void>;
}

/** What to do with one request or tool call. */
export type Decision<S extends Step> =
  | { kind: "replay"; step: S }
  // `commit(undefined)` drops the step (transient error, network failure).
  // Call it exactly once; a commit after `finish()` is ignored.
  | { kind: "live"; commit(step: S | undefined): void }
  | { kind: "fail"; error: ChangeDetectedError };

/** A step made live, ordered by when its request was issued. */
interface LiveEntry {
  seq: number;
  step: Step;
}

/** The first change in strict mode, and the error the failed decision returned. */
interface Mismatch {
  report: ChangeReport;
  error: ChangeDetectedError;
}

/**
 * Tracks one `replay()` call.
 *
 * Matching never depends on completion order. Each decision takes a sequence
 * number when the request is issued, and a request matches the earliest
 * unconsumed recorded step with the same match key.
 */
export class Session {
  /** Recording name, as passed to `replay()`. */
  readonly name: string;

  private readonly opts: SessionOptions;
  private readonly steps: readonly Step[];
  private readonly keys: readonly string[];
  private readonly consumed = new Set<number>();
  private readonly live: LiveEntry[] = [];
  private seq = 0;
  private extraCount = 0;
  private firstMismatch: Mismatch | undefined;
  private switched = false;
  private isClosed = false;

  /**
   * @param opts - Strategy, recording, and the functions the session needs.
   */
  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.steps = opts.recording?.steps ?? [];
    this.keys = this.steps.map((step) => this.keyOfStep(step));
  }

  /**
   * Whether `finish()` has been called. Decisions asked for afterwards throw.
   *
   * @returns True once the replay is over.
   */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Decides what to do with a provider request.
   *
   * @param request - The captured, redacted request.
   * @returns Replay a step, go live, or fail with a change report.
   * @throws {ProviderCallBlockedError} When the session is closed.
   */
  decideLlm(request: RecordedRequest): Decision<LlmStep> {
    if (this.isClosed) throw new ProviderCallBlockedError(request.url, "after-replay");
    const key = llmMatchKey(request, this.opts.config);
    // Only the request is shown in a report; the response is not known yet.
    const live: LlmStep = {
      type: "llm",
      request,
      response: { status: 0, headers: {} },
    };
    return this.decide<LlmStep>(live, key);
  }

  /**
   * Decides what to do with a wrapped tool call.
   *
   * @param name - Tool name.
   * @param args - Arguments, already converted with `toJsonArgs`.
   * @returns Replay a step, go live, or fail with a change report.
   * @throws {ReplayUsageError} When the session is closed.
   */
  decideTool(name: string, args: JsonValue[]): Decision<ToolStep> {
    if (this.isClosed) {
      throw new ReplayUsageError(
        `agent-retrace: tool ${JSON.stringify(name)} was called after replay(${JSON.stringify(this.opts.name)}) had finished. Await all of the agent's work inside replay().`,
      );
    }
    const key = toolMatchKey(name, args);
    // Only the name and arguments are shown in a report; the outcome is not known yet.
    const live: ToolStep = { type: "tool", name, args, outcome: { type: "return" } };
    return this.decide<ToolStep>(live, key);
  }

  /**
   * Ends the replay: reports any change, and saves the recording when the
   * strategy calls for it.
   *
   * @param fnError - The error the replayed function threw, if any.
   * @throws {ChangeDetectedError} On the first mismatch (with the function's error as `cause`), or when the agent made fewer calls than recorded.
   * @throws The function's own error when there was no change.
   * @throws Any error from `save`.
   */
  async finish(fnError: { error: unknown } | undefined): Promise<void> {
    // Closed before saving so a request racing with the write is refused.
    this.isClosed = true;
    const { strategy } = this.opts;
    if (strategy === "record") {
      if (fnError) throw fnError.error;
      await this.opts.save(this.recordingOf(this.liveSteps()));
      return;
    }
    if (strategy === "update") {
      if (fnError) throw fnError.error;
      if (this.switched || this.consumed.size < this.steps.length) {
        const kept = [...this.consumed].sort((a, b) => a - b).map((i) => this.steps[i] as Step);
        await this.opts.save(this.recordingOf([...kept, ...this.liveSteps()]));
      }
      return;
    }
    if (this.firstMismatch) {
      const { report, error } = this.firstMismatch;
      // The failed decision's error usually comes back out of the agent,
      // directly or wrapped by the SDK. Wrapping it again would print the
      // report twice.
      if (!fnError || causeChainIncludes(fnError.error, error)) throw error;
      throw this.errorOf(report, { cause: fnError.error });
    }
    if (fnError) throw fnError.error;
    const next = this.earliestUnconsumed(() => true);
    if (next !== undefined) {
      throw this.errorOf(this.report("missing", next + 1, this.steps[next], undefined));
    }
  }

  /**
   * Shared decision logic for both step types.
   *
   * @param live - The step the agent is making, with placeholders for what is not known yet.
   * @param key - Its match key.
   * @returns The decision.
   */
  private decide<S extends Step>(live: S, key: string): Decision<S> {
    const seq = this.seq++;
    const { strategy } = this.opts;
    if (strategy === "record" || this.switched) return this.goLive<S>(seq);

    const matched = this.earliestUnconsumed(
      (step, i) => step.type === live.type && this.keys[i] === key,
    );
    if (matched !== undefined) {
      this.consumed.add(matched);
      return { kind: "replay", step: this.steps[matched] as S };
    }

    if (strategy === "update") {
      this.switched = true;
      return this.goLive<S>(seq);
    }
    const report = this.mismatchReport(live);
    const error = this.errorOf(report);
    this.firstMismatch ??= { report, error };
    return { kind: "fail", error };
  }

  /**
   * Makes a live decision whose step is stored in issue order when committed.
   *
   * @param seq - Sequence number taken when the request was issued.
   * @returns A live decision whose `commit` throws if called twice.
   */
  private goLive<S extends Step>(seq: number): Decision<S> {
    let committed = false;
    return {
      kind: "live",
      commit: (step) => {
        if (committed) throw new Error(`agent-retrace bug: step ${seq} committed more than once`);
        committed = true;
        // A request still in flight when the replay ended cannot change a
        // recording that is already being saved.
        if (step !== undefined && !this.isClosed) this.live.push({ seq, step });
      },
    };
  }

  /**
   * Builds the report for a live step that matches nothing, comparing it with
   * the most plausible recorded step.
   *
   * @param live - The live step.
   * @returns A `changed` report, or `extra` when nothing is left to compare with.
   */
  private mismatchReport(live: Step): ChangeReport {
    const sameType = this.earliestUnconsumed((step) => step.type === live.type);
    let target = sameType;
    if (live.type === "tool") {
      target =
        this.earliestUnconsumed((step) => step.type === "tool" && step.name === live.name) ??
        sameType;
    }
    target ??= this.earliestUnconsumed(() => true);
    if (target === undefined) {
      this.extraCount++;
      return this.report("extra", this.consumed.size + this.extraCount, undefined, live);
    }
    return this.report("changed", target + 1, this.steps[target], live);
  }

  /**
   * Builds a change report.
   *
   * @param kind - The kind of change.
   * @param stepNumber - 1-based step the report is about.
   * @param recorded - The recorded step involved, absent for `extra`.
   * @param live - The live step, absent for `missing`.
   * @returns The report.
   */
  private report(
    kind: ChangeReport["kind"],
    stepNumber: number,
    recorded: Step | undefined,
    live: Step | undefined,
  ): ChangeReport {
    return {
      recordingName: this.opts.name,
      recordingPath: this.opts.recordingPath,
      kind,
      stepNumber,
      totalSteps: this.steps.length,
      ...(recorded ? { recorded } : {}),
      ...(live ? { live } : {}),
      command: this.opts.command,
      ignore: this.opts.config.ignore,
    };
  }

  /**
   * Turns a report into the error thrown to the test.
   *
   * @param report - The report.
   * @param options - Standard error options, e.g. the SDK error as `cause`.
   * @returns The error, whose message is the rendered report.
   */
  private errorOf(report: ChangeReport, options?: { cause?: unknown }): ChangeDetectedError {
    return new ChangeDetectedError(
      renderChange(report),
      {
        recordingName: report.recordingName,
        stepNumber: report.stepNumber,
        totalSteps: report.totalSteps,
      },
      options,
    );
  }

  /**
   * Finds the earliest recorded step that is unconsumed and passes a filter.
   *
   * @param accept - Receives the step and its 0-based index.
   * @returns The index, or undefined when none qualifies.
   */
  private earliestUnconsumed(accept: (step: Step, index: number) => boolean): number | undefined {
    for (let i = 0; i < this.steps.length; i++) {
      if (!this.consumed.has(i) && accept(this.steps[i] as Step, i)) return i;
    }
    return undefined;
  }

  /**
   * Computes the match key of a recorded step.
   *
   * @param step - The recorded step.
   * @returns Its match key.
   */
  private keyOfStep(step: Step): string {
    return step.type === "llm"
      ? llmMatchKey(step.request, this.opts.config)
      : toolMatchKey(step.name, step.args);
  }

  /**
   * Returns the committed live steps in the order their requests were issued.
   *
   * @returns The steps.
   */
  private liveSteps(): Step[] {
    return [...this.live].sort((a, b) => a.seq - b.seq).map((entry) => entry.step);
  }

  /**
   * Wraps steps into a recording with this session's name.
   *
   * @param steps - The steps.
   * @returns The recording.
   */
  private recordingOf(steps: Step[]): Recording {
    return { formatVersion: 1, name: this.opts.name, steps };
  }
}

/**
 * Whether `target` is `error` itself or anywhere in its `cause` chain.
 *
 * @param error - The error to search, e.g. what the agent threw.
 * @param target - The error to look for.
 * @returns True when found.
 */
function causeChainIncludes(error: unknown, target: unknown): boolean {
  // `seen` guards against a cause chain that loops back on itself.
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current === target) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
