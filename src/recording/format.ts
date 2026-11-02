/**
 * The recording file format: types, stable serialization and validated
 * parsing. Pure, no I/O.
 */
import { RecordingFormatError } from "../errors.js";
import { isObject, type JsonValue } from "./json.js";

export type { JsonValue } from "./json.js";

/** Format version written by this release. */
export const FORMAT_VERSION = 1;

/** An HTTP request as stored in a recording. Auth headers are never stored. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON body. */
  body?: JsonValue;
  /** Raw body when it is not JSON. */
  text?: string;
}

/** One server-sent event. `data` is parsed JSON; `text` is raw non-JSON data. */
export interface SseEvent {
  event?: string;
  data?: JsonValue;
  text?: string;
}

/** An HTTP response as stored in a recording. Exactly one of body/text/events is set. */
export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body?: JsonValue;
  text?: string;
  events?: SseEvent[];
}

/** A recorded call to a provider host. */
export interface LlmStep {
  type: "llm";
  request: RecordedRequest;
  response: RecordedResponse;
}

/** An error a tool threw, as stored in a recording. */
export interface RecordedError {
  name: string;
  message: string;
  /** Own enumerable fields with primitive values, such as `code` or `status`. */
  props?: { [k: string]: string | number | boolean | null };
  /** The error's `cause`, when that is an Error too. */
  cause?: RecordedError;
}

/** How a recorded tool call ended. */
export type ToolOutcome =
  | { type: "return"; value?: JsonValue }
  | ({ type: "throw" } & RecordedError);

/** A recorded call to a wrapped tool. */
export interface ToolStep {
  type: "tool";
  name: string;
  args: JsonValue[];
  outcome: ToolOutcome;
}

/** One step of a recording. */
export type Step = LlmStep | ToolStep;

/** A whole recording file. */
export interface Recording {
  formatVersion: 1;
  name: string;
  steps: Step[];
}

// Keys that read best near the top of an object, in this order. Everything
// else follows alphabetically, so a file only changes where its data does.
const KEY_PRIORITY = [
  "formatVersion",
  "name",
  "type",
  "steps",
  "method",
  "url",
  "status",
  "headers",
  "request",
  "response",
  "args",
  "outcome",
  "value",
  "message",
  "event",
  "data",
  "text",
  "body",
  "events",
];
const PRIORITY_RANK = new Map(KEY_PRIORITY.map((key, i) => [key, i]));

/**
 * Orders two object keys: priority keys first, then by UTF-16 code unit.
 * `localeCompare` is avoided because its order depends on the machine's locale.
 *
 * @param a - First key.
 * @param b - Second key.
 * @returns Negative, zero or positive, as for `Array.prototype.sort`.
 */
function compareKeys(a: string, b: string): number {
  const ra = PRIORITY_RANK.get(a) ?? KEY_PRIORITY.length;
  const rb = PRIORITY_RANK.get(b) ?? KEY_PRIORITY.length;
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reports whether `JSON.stringify` would leave a property out (or write
 * `null` for it inside an array).
 *
 * @param value - A property or element value.
 * @returns True for undefined, functions and symbols.
 */
function isSkipped(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/**
 * Serializes one value at a given depth.
 *
 * @param value - The value to write.
 * @param indent - Indentation of the line the value starts on.
 * @param ancestors - Objects currently being written, to detect cycles.
 * @param pretty - Whether to write one item per line, indented, or everything on one line.
 * @returns The JSON text.
 * @throws {TypeError} On a circular structure or a bigint, as `JSON.stringify` does.
 */
function write(value: unknown, indent: string, ancestors: Set<object>, pretty: boolean): string {
  if (value !== null && typeof value === "object" && "toJSON" in value) {
    const toJSON = (value as { toJSON: unknown }).toJSON;
    if (typeof toJSON === "function") value = toJSON.call(value);
  }
  if (value === null || typeof value !== "object") {
    // Defers to JSON.stringify for strings, numbers (NaN and Infinity become
    // null) and booleans, and for the TypeError it throws on a bigint.
    return JSON.stringify(value) ?? "null";
  }
  if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
  ancestors.add(value);
  const inner = `${indent}  `;
  const open = pretty ? `\n${inner}` : "";
  const separator = pretty ? `,\n${inner}` : ",";
  const close = pretty ? `\n${indent}` : "";
  let out: string;
  if (Array.isArray(value)) {
    // `Array.from` visits holes in sparse arrays as undefined; `map` would skip
    // them and leave a bare "," in the output.
    const items = Array.from(value, (item) =>
      isSkipped(item) ? "null" : write(item, inner, ancestors, pretty),
    );
    out = items.length === 0 ? "[]" : `[${open}${items.join(separator)}${close}]`;
  } else {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => !isSkipped(record[key]))
      .sort(compareKeys)
      .map(
        (key) =>
          `${JSON.stringify(key)}${pretty ? ": " : ":"}${write(record[key], inner, ancestors, pretty)}`,
      );
    out = entries.length === 0 ? "{}" : `{${open}${entries.join(separator)}${close}}`;
  }
  ancestors.delete(value);
  return out;
}

/**
 * Serializes a value as pretty JSON with a stable key order: the keys in
 * `KEY_PRIORITY` first, the rest alphabetically. Arrays keep their order.
 * Two-space indent and a trailing newline, so files diff cleanly in git.
 *
 * `JSON.stringify` cannot do this by reordering keys first: JavaScript objects
 * always list integer-like keys ("2", "10") before other keys, in numeric
 * order, whatever order they were inserted in. Python dicts and Go maps
 * marshalled with sorted keys have no such rule.
 *
 * @param value - Any JSON-compatible value.
 * @returns The JSON text, ending in "\n".
 * @throws {TypeError} On a circular structure or a bigint.
 */
export function stableStringify(value: unknown): string {
  return `${write(value, "", new Set(), true)}\n`;
}

/**
 * Serializes a value on one line, without whitespace, in the same stable key
 * order as {@link stableStringify}. For summaries that show a value the way
 * its recording file orders it.
 *
 * @param value - Any JSON-compatible value.
 * @returns The JSON text, with no trailing newline.
 * @throws {TypeError} On a circular structure or a bigint.
 */
export function stableStringifyLine(value: unknown): string {
  return write(value, "", new Set(), false);
}

/**
 * Serializes a recording for writing to disk.
 *
 * @param r - The recording.
 * @returns The file contents.
 */
export function serializeRecording(r: Recording): string {
  return stableStringify(r);
}

/**
 * Reports whether every value of an object is a string.
 *
 * @param value - Any parsed JSON value.
 * @returns True for a string-to-string record.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((v) => typeof v === "string");
}

/**
 * Checks the shape of a response payload: exactly one of body/text/events,
 * a string `text`, and events that are objects with string `event`/`text`.
 *
 * @param response - The parsed response object.
 * @returns Why the payload is invalid, or undefined when it is valid.
 */
function responsePayloadProblem(response: Record<string, unknown>): string | undefined {
  const present = ["body", "text", "events"].filter((key) => response[key] !== undefined);
  if (present.length !== 1) {
    return `has a response with ${present.length === 0 ? "none" : present.join(" and ")} of body, text and events, expected exactly one`;
  }
  if (response.text !== undefined && typeof response.text !== "string") {
    return "has a response text that is not a string";
  }
  if (response.events === undefined) return undefined;
  if (!Array.isArray(response.events)) return "has response events that are not an array";
  for (const [i, event] of response.events.entries()) {
    if (!isObject(event)) return `has response event ${i + 1} that is not an object`;
    if (event.event !== undefined && typeof event.event !== "string") {
      return `has response event ${i + 1} with an event name that is not a string`;
    }
    if (event.text !== undefined && typeof event.text !== "string") {
      return `has response event ${i + 1} with a text that is not a string`;
    }
  }
  return undefined;
}

/**
 * Checks the shape of a recorded error and of the causes nested in it.
 *
 * @param error - The parsed error object.
 * @param what - What the error is, for the message, e.g. "a thrown outcome".
 * @returns Why the error is invalid, or undefined when it is valid.
 */
function recordedErrorProblem(error: Record<string, unknown>, what: string): string | undefined {
  if (typeof error.name !== "string" || typeof error.message !== "string") {
    return `has ${what} without a string name and message`;
  }
  if (
    error.props !== undefined &&
    !(
      isObject(error.props) &&
      Object.values(error.props).every((v) => v === null || typeof v !== "object")
    )
  ) {
    return `has ${what} whose props are not an object of strings, numbers, booleans and nulls`;
  }
  if (error.cause === undefined) return undefined;
  if (!isObject(error.cause)) return `has ${what} whose cause is not an object`;
  return recordedErrorProblem(error.cause, `${what} cause`);
}

/**
 * Checks the shape of one step, enough that later code can index into it
 * without crashing on a hand-edited file.
 *
 * @param step - The parsed step.
 * @returns Why the step is invalid, or undefined when it is valid.
 */
function stepProblem(step: unknown): string | undefined {
  if (!isObject(step)) return "is not an object";
  if (step.type === "llm") {
    const { request, response } = step;
    if (!isObject(request)) return "has no request object";
    if (typeof request.method !== "string" || typeof request.url !== "string") {
      return "has a request without a string method and url";
    }
    if (!isStringRecord(request.headers)) return "has request headers that are not all strings";
    if (request.text !== undefined && typeof request.text !== "string") {
      return "has a request text that is not a string";
    }
    if (!isObject(response)) return "has no response object";
    if (!Number.isInteger(response.status)) return "has a response without an integer status";
    if (!isStringRecord(response.headers)) return "has response headers that are not all strings";
    return responsePayloadProblem(response);
  }
  if (step.type === "tool") {
    const { outcome } = step;
    if (typeof step.name !== "string") return "has no string name";
    if (!Array.isArray(step.args)) return "has args that are not an array";
    if (!isObject(outcome)) return "has no outcome object";
    if (outcome.type === "return") return undefined;
    if (outcome.type === "throw") return recordedErrorProblem(outcome, "a thrown outcome");
    return `has unknown outcome type ${JSON.stringify(outcome.type)}`;
  }
  return `has unknown type ${JSON.stringify(step.type)}`;
}

/**
 * Parses and validates a recording file.
 *
 * @param text - The file contents.
 * @param filePath - Path of the file, used in error messages.
 * @returns The recording.
 * @throws {RecordingFormatError} When the text is not JSON, the format version
 *   is missing, not an integer or newer than this release, or the structure or
 *   a step is malformed.
 */
export function parseRecording(text: string, filePath: string): Recording {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RecordingFormatError(filePath, `not valid JSON (${(err as Error).message})`);
  }
  if (!isObject(parsed)) throw new RecordingFormatError(filePath, "not a JSON object");
  const version = parsed.formatVersion;
  if (!Number.isInteger(version)) {
    throw new RecordingFormatError(filePath, "missing or non-integer formatVersion");
  }
  if ((version as number) > FORMAT_VERSION) {
    throw new RecordingFormatError(
      filePath,
      `formatVersion ${version} was written by a newer agent-retrace, upgrade the package`,
    );
  }
  if (version !== FORMAT_VERSION) {
    throw new RecordingFormatError(filePath, `unsupported formatVersion ${version}`);
  }
  if (typeof parsed.name !== "string") throw new RecordingFormatError(filePath, "missing name");
  if (!Array.isArray(parsed.steps)) {
    throw new RecordingFormatError(filePath, "steps is not an array");
  }
  parsed.steps.forEach((step, i) => {
    const problem = stepProblem(step);
    if (problem !== undefined) throw new RecordingFormatError(filePath, `step ${i + 1} ${problem}`);
  });
  return parsed as unknown as Recording;
}
