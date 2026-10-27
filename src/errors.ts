/**
 * Error classes thrown by agent-retrace. Every error extends
 * `AgentRetraceError`, so callers can catch all of them with one check.
 */

/**
 * Base class for every error thrown by agent-retrace.
 */
export class AgentRetraceError extends Error {
  /**
   * @param message - Human-readable description of the problem.
   * @param options - Standard error options, e.g. `cause`.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // `new.target` is the subclass actually being constructed, so every
    // subclass gets its own name without repeating this line. Python sets the
    // class name on exceptions automatically; JavaScript leaves it as "Error".
    this.name = new.target.name;
  }
}

/**
 * Thrown when `AGENT_RETRACE_MODE` holds a value other than the three modes.
 */
export class InvalidModeError extends AgentRetraceError {
  /** The rejected value. */
  readonly value: string;

  /**
   * @param value - The value found in `AGENT_RETRACE_MODE`.
   */
  constructor(value: string) {
    super(
      `Invalid AGENT_RETRACE_MODE ${JSON.stringify(value)}. Valid values are "replay", "auto" and "update".`,
    );
    this.value = value;
  }
}

/**
 * Thrown when a recording name cannot be used as a file name.
 */
export class InvalidRecordingNameError extends AgentRetraceError {
  /** The rejected recording name. */
  readonly recordingName: string;

  /**
   * @param name - The recording name passed to `replay()`.
   */
  constructor(name: string) {
    super(
      `Invalid recording name ${JSON.stringify(name)}. Use letters, digits, ".", "_", "-" and "/" separated path segments.`,
    );
    this.recordingName = name;
  }
}

/**
 * Thrown when a recording file exists but cannot be parsed or has an
 * unsupported shape or format version.
 */
export class RecordingFormatError extends AgentRetraceError {
  /** Absolute path of the bad recording file. */
  readonly filePath: string;
  /** Why the file was rejected. */
  readonly reason: string;

  /**
   * @param filePath - Absolute path of the recording file.
   * @param reason - Why the file was rejected.
   */
  constructor(filePath: string, reason: string) {
    super(`Invalid recording file ${filePath}: ${reason}`);
    this.filePath = filePath;
    this.reason = reason;
  }
}

/**
 * Thrown in `replay` mode when the recording a test needs does not exist.
 */
export class RecordingNotFoundError extends AgentRetraceError {
  /** Name of the missing recording. */
  readonly recordingName: string;
  /** Path where the recording was expected. */
  readonly filePath: string;
  /** Command that records it. */
  readonly command: string;

  /**
   * @param recordingName - Name passed to `replay()`.
   * @param filePath - Absolute path where the recording was expected.
   * @param command - Shell command that records it.
   */
  constructor(recordingName: string, filePath: string, command: string) {
    super(`No recording "${recordingName}" at ${filePath}. Record it with:\n\n  ${command}\n`);
    this.recordingName = recordingName;
    this.filePath = filePath;
    this.command = command;
  }
}

/**
 * Thrown when the agent's behavior differs from its recording. The message is
 * the full rendered change report.
 */
export class ChangeDetectedError extends AgentRetraceError {
  /** Name of the recording that no longer matches. */
  readonly recordingName: string;
  /** 1-based step at which the agent changed. */
  readonly stepNumber: number;
  /** Number of steps in the recording. */
  readonly totalSteps: number;

  /**
   * @param report - Rendered change report, used as the message.
   * @param info - Where the change happened.
   * @param options - Standard error options, e.g. the SDK error as `cause`.
   */
  constructor(
    report: string,
    info: { recordingName: string; stepNumber: number; totalSteps: number },
    options?: { cause?: unknown },
  ) {
    super(report, options);
    this.recordingName = info.recordingName;
    this.stepNumber = info.stepNumber;
    this.totalSteps = info.totalSteps;
  }
}

/** Why a provider call was refused. */
export type BlockReason = "outside-replay" | "after-replay" | "node-http";

const BLOCK_EXPLANATIONS: Record<BlockReason, string> = {
  "outside-replay": "it was made outside replay() in replay mode",
  "after-replay": "it was made after its replay() call had finished",
  "node-http": "it used node:http/https, which agent-retrace cannot record (use fetch or undici)",
};

/**
 * Thrown when a request to a provider host is refused instead of being sent.
 */
export class ProviderCallBlockedError extends AgentRetraceError {
  /** URL of the blocked request. */
  readonly url: string;
  /** Why it was blocked. */
  readonly reason: BlockReason;

  /**
   * @param url - URL of the blocked request.
   * @param reason - Why it was blocked.
   */
  constructor(url: string, reason: BlockReason) {
    super(`agent-retrace blocked a provider call to ${url}: ${BLOCK_EXPLANATIONS[reason]}.`);
    this.url = url;
    this.reason = reason;
  }
}

/**
 * Thrown when the library is used incorrectly, e.g. nested `replay()` calls or
 * tool arguments that cannot be stored as JSON.
 */
export class ReplayUsageError extends AgentRetraceError {}
