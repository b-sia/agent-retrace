#!/usr/bin/env node
/**
 * The `agent-retrace` command line: `agent-retrace inspect <file>` prints a
 * recording as a readable timeline, one entry per step with what was asked
 * and what came back. Reads only the file it is given; never loads the
 * interceptor, so it has no effect on HTTP.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { type ApiShape, toolCallLine, toSemantic } from "./diff/semantic.js";
import { RecordingFormatError } from "./errors.js";
import {
  type LlmStep,
  parseRecording,
  type RecordedError,
  type Recording,
  type SseEvent,
  type Step,
  stableStringifyLine,
} from "./recording/format.js";
import { asArray, asString, isObject, type JsonObject, type JsonValue } from "./recording/json.js";
import { type Colors, oneLine } from "./terminal.js";

/** Options for {@link formatTimeline}. */
export interface TimelineOptions {
  /** Whether to emit ANSI colors. Defaults to {@link shouldColor} for stdout. */
  color?: boolean;
}

/** What an assistant answered: its text, the tools it asked for, and how it failed. */
interface Answer {
  text: string;
  calls: { name: JsonValue | undefined; args: JsonValue | undefined }[];
  /** Set when a 2xx response still reports a failure, e.g. an error event mid-stream. */
  error?: string;
}

const USAGE = "Usage: agent-retrace inspect <file> [--color | --no-color]";
const HELP = `${USAGE}

Prints a recording as a timeline: one entry per step, with the last message
sent and the answer for LLM calls, and the arguments and outcome for tools.

Options:
  --color      Always color the output.
  --no-color   Never color the output.
  -h, --help   Show this help.

Without a flag, the output is colored on a terminal. NO_COLOR turns colors
off and FORCE_COLOR turns them on (FORCE_COLOR=0 turns them off).

Exit codes: 0 ok, 1 unreadable or invalid file, 2 bad usage.
`;

// Longest summary shown on one line, "..." included.
const MAX_SUMMARY = 100;
// The columns between a step's number and its content: "  LLM   " or "  tool  ".
const TAG_WIDTH = 8;
// Detail markers ("< ", "> ") end where the step's content starts.
const MARK_WIDTH = 2;
// The Responses API events that end a stream and carry the final response.
const RESPONSES_DONE = new Set(["response.completed", "response.failed", "response.incomplete"]);

/**
 * Decides whether to color output. A `--color` or `--no-color` flag wins;
 * then a non-empty `NO_COLOR` turns colors off, and `FORCE_COLOR` turns them
 * on unless it is `0` or `false`; otherwise output is colored on a terminal
 * that is not `TERM=dumb`, so piping to a file or `less` gets plain text.
 *
 * @param flag - The `--color` (true) or `--no-color` (false) flag, if given.
 * @param env - The environment, e.g. `process.env`.
 * @param isTTY - Whether the output is a terminal.
 * @returns True to color.
 */
export function shouldColor(
  flag: boolean | undefined,
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
): boolean {
  if (flag !== undefined) return flag;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  return isTTY && env.TERM !== "dumb";
}

/**
 * Shortens text to {@link MAX_SUMMARY} characters, ending in "...". Counts
 * code points, not UTF-16 code units, so an emoji is never cut in half.
 *
 * @param text - One line of text.
 * @returns The text, at most {@link MAX_SUMMARY} code points long.
 */
function truncate(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_SUMMARY ? text : `${chars.slice(0, MAX_SUMMARY - 3).join("")}...`;
}

/**
 * Describes a provider error object (`{type, code, message}` in any of the
 * three APIs) as "kind: message".
 *
 * @param value - The error object.
 * @returns E.g. "overloaded_error: Overloaded".
 */
function describeError(value: JsonValue | undefined): string {
  const e = isObject(value) ? value : {};
  // A Responses `error` event is itself the error, with type "error".
  const kind = asString(e.code) ?? (e.type === "error" ? undefined : asString(e.type));
  const parts = [kind, asString(e.message)].filter((p) => p !== undefined && p !== "");
  return parts.length > 0 ? parts.join(": ") : "unknown error";
}

/**
 * Reads an OpenAI Chat Completions message (`choices[0].message`).
 *
 * @param message - The message.
 * @returns The answer.
 */
function chatAnswer(message: JsonValue | undefined): Answer {
  const m = isObject(message) ? message : {};
  const calls = asArray(m.tool_calls).map((call) => {
    const fn = isObject(call) && isObject(call.function) ? call.function : {};
    return { name: fn.name, args: fn.arguments };
  });
  return { text: asString(m.content) ?? "", calls };
}

/**
 * Rebuilds the first choice of an OpenAI Chat Completions answer from
 * streamed chunks: text deltas are concatenated, and tool call fragments are
 * joined by `index`. With `n > 1` each chunk carries one choice, so chunks
 * for other choices are skipped. An `error` chunk records the failure.
 *
 * @param events - The stream's events.
 * @returns The answer.
 */
function chatStreamAnswer(events: SseEvent[]): Answer {
  let text = "";
  let error: string | undefined;
  const calls: { name: string; args: string }[] = [];
  for (const { data } of events) {
    if (!isObject(data)) continue;
    if (data.error !== undefined) error = describeError(data.error);
    const choice = asArray(data.choices).find(
      (c) => isObject(c) && (typeof c.index === "number" ? c.index : 0) === 0,
    );
    const delta = isObject(choice) && isObject(choice.delta) ? choice.delta : {};
    text += asString(delta.content) ?? "";
    for (const call of asArray(delta.tool_calls)) {
      if (!isObject(call)) continue;
      const index = typeof call.index === "number" ? call.index : calls.length;
      const slot = calls[index] ?? { name: "", args: "" };
      calls[index] = slot;
      const fn = isObject(call.function) ? call.function : {};
      slot.name += asString(fn.name) ?? "";
      slot.args += asString(fn.arguments) ?? "";
    }
  }
  // A sparse array (an index never sent) would leave holes; skip them.
  return { text, calls: calls.filter((call) => call !== undefined), error };
}

/**
 * Reads the `output` items of an OpenAI Responses API response.
 *
 * @param output - The output items.
 * @returns The answer.
 */
function responsesOutput(output: JsonValue[]): Answer {
  const answer: Answer = { text: "", calls: [] };
  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type === "message") {
      for (const part of asArray(item.content)) {
        if (isObject(part) && part.type === "output_text") answer.text += asString(part.text) ?? "";
      }
    } else if (item.type === "function_call") {
      answer.calls.push({ name: item.name, args: item.arguments });
    }
  }
  return answer;
}

/**
 * Reads an OpenAI Responses API response object: its output, and its error
 * when its status is `failed` or `incomplete`.
 *
 * @param response - The response object (a body, or a final stream event's `response`).
 * @returns The answer.
 */
function responsesAnswer(response: JsonObject): Answer {
  const answer = responsesOutput(asArray(response.output));
  if (response.status === "failed") {
    answer.error = describeError(response.error);
  } else if (response.status === "incomplete") {
    const details = isObject(response.incomplete_details) ? response.incomplete_details : {};
    answer.error = `incomplete: ${asString(details.reason) ?? "unknown reason"}`;
  }
  return answer;
}

/**
 * Rebuilds an OpenAI Responses API answer from its stream: the response of
 * the final `response.completed`, `response.failed` or `response.incomplete`
 * event, else the items announced as done, else the concatenated text deltas
 * of a stream that was cut short. An `error` event records the failure.
 *
 * @param events - The stream's events.
 * @returns The answer.
 */
function responsesStreamAnswer(events: SseEvent[]): Answer {
  const data = events.map((e) => (isObject(e.data) ? e.data : {}));
  const final = data.findLast((d) => RESPONSES_DONE.has(asString(d.type) ?? ""));
  const done = data.filter((d) => d.type === "response.output_item.done").map((d) => d.item ?? {});
  let answer: Answer;
  if (final !== undefined && isObject(final.response)) {
    answer = responsesAnswer(final.response);
  } else if (done.length > 0) {
    answer = responsesOutput(done);
  } else {
    const text = data
      .filter((d) => d.type === "response.output_text.delta")
      .map((d) => asString(d.delta) ?? "")
      .join("");
    answer = { text, calls: [] };
  }
  const errorEvent = data.findLast((d) => d.type === "error");
  if (answer.error === undefined && errorEvent !== undefined) {
    answer.error = describeError(errorEvent);
  }
  return answer;
}

/**
 * Reads the content blocks of an Anthropic message.
 *
 * @param content - The content blocks.
 * @returns The answer.
 */
function anthropicAnswer(content: JsonValue[]): Answer {
  const answer: Answer = { text: "", calls: [] };
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text") answer.text += asString(block.text) ?? "";
    if (block.type === "tool_use") answer.calls.push({ name: block.name, args: block.input });
  }
  return answer;
}

/**
 * Rebuilds an Anthropic message from its stream: each `content_block_start`
 * opens a block at its `index`, and `content_block_delta` events append text
 * or partial tool input JSON to it. An `error` event records the failure.
 *
 * @param events - The stream's events.
 * @returns The answer.
 */
function anthropicStreamAnswer(events: SseEvent[]): Answer {
  const blocks: {
    type: string;
    name?: JsonValue;
    input?: JsonValue;
    text: string;
    json: string;
  }[] = [];
  let error: string | undefined;
  for (const { data } of events) {
    if (!isObject(data)) continue;
    if (data.type === "error") error = describeError(data.error);
    if (typeof data.index !== "number") continue;
    if (data.type === "content_block_start" && isObject(data.content_block)) {
      const block = data.content_block;
      blocks[data.index] = {
        type: asString(block.type) ?? "",
        name: block.name,
        input: block.input,
        text: asString(block.text) ?? "",
        json: "",
      };
    } else if (data.type === "content_block_delta" && isObject(data.delta)) {
      const block = blocks[data.index];
      if (block === undefined) continue;
      block.text += asString(data.delta.text) ?? "";
      block.json += asString(data.delta.partial_json) ?? "";
    }
  }
  const answer: Answer = { text: "", calls: [], error };
  for (const block of blocks) {
    if (block?.type === "text") answer.text += block.text;
    // A tool_use block starts with an `input` (usually `{}`) that the deltas
    // replace; with no partial JSON, the starting input is the input.
    if (block?.type === "tool_use") {
      answer.calls.push({ name: block.name, args: block.json !== "" ? block.json : block.input });
    }
  }
  return answer;
}

/**
 * Works out what the assistant answered in a successful LLM step, for the
 * three provider APIs the semantic view understands, streamed or not.
 *
 * @param step - The LLM step, with a 2xx response.
 * @param api - The step's provider API.
 * @returns The answer, or undefined for another API or a body of the wrong shape.
 */
function answerOf(step: LlmStep, api: ApiShape): Answer | undefined {
  const { body, events } = step.response;
  const obj = isObject(body) ? body : undefined;
  if (api === "openai-chat") {
    if (events !== undefined) return chatStreamAnswer(events);
    const choice = asArray(obj?.choices)[0];
    return obj && chatAnswer(isObject(choice) ? choice.message : undefined);
  }
  if (api === "openai-responses") {
    if (events !== undefined) return responsesStreamAnswer(events);
    return obj && responsesAnswer(obj);
  }
  if (api === "anthropic-messages") {
    if (events !== undefined) return anthropicStreamAnswer(events);
    return obj && anthropicAnswer(asArray(obj.content));
  }
  return undefined;
}

/**
 * Summarizes an answer: one line for the text, one per tool call and one for
 * the error, or the HTTP status when there is nothing to show.
 *
 * @param answer - The answer, if one could be read.
 * @param status - The HTTP status.
 * @returns The summary lines, without the "< " marker.
 */
function responseLines(answer: Answer | undefined, status: number): string[] {
  const lines: string[] = [];
  if (answer !== undefined && answer.text !== "") lines.push(`assistant: ${oneLine(answer.text)}`);
  for (const call of answer?.calls ?? []) lines.push(toolCallLine(call.name, call.args));
  if (answer?.error !== undefined) lines.push(`error: ${answer.error}`);
  return lines.length > 0 ? lines : [`HTTP ${status}`];
}

/**
 * Formats a thrown error on one line.
 *
 * @param error - The recorded error.
 * @returns E.g. "throws TypeError: boom".
 */
function thrown(error: RecordedError): string {
  return `throws ${error.name}: ${error.message}`;
}

/**
 * Formats one detail line under a step: indented to the step's content,
 * made safe for the terminal, shortened and colored.
 *
 * @param indent - The spaces before the marker.
 * @param mark - ">" for what was sent, "<" for what came back.
 * @param text - The detail.
 * @param color - Colors the whole line.
 * @returns The line.
 */
function detailLine(
  indent: string,
  mark: string,
  text: string,
  color: (s: string) => string,
): string {
  return color(`${indent}${mark} ${truncate(oneLine(text))}`);
}

/**
 * Formats one step as its header line plus detail lines.
 *
 * @param step - The step.
 * @param label - The step number, already padded.
 * @param c - Colors.
 * @returns The lines.
 */
function stepLines(step: Step, label: string, c: Colors): string[] {
  const indent = " ".repeat(label.length + TAG_WIDTH - MARK_WIDTH);
  if (step.type === "tool") {
    const call = truncate(oneLine(`${step.name}(${step.args.map(stableStringifyLine).join(",")})`));
    const outcome = step.outcome;
    const result =
      outcome.type === "throw"
        ? detailLine(indent, "<", thrown(outcome), c.red)
        : detailLine(
            indent,
            "<",
            outcome.value === undefined ? "undefined" : stableStringifyLine(outcome.value),
            c.green,
          );
    return [`${c.bold(label)}  ${c.magenta("tool")}  ${call}`, result];
  }
  const semantic = toSemantic(step.request);
  const body = isObject(step.request.body) ? step.request.body : {};
  const tags = [
    ...(semantic.model !== undefined ? [`model=${oneLine(semantic.model)}`] : []),
    ...(body.stream === true || step.response.events !== undefined ? ["stream"] : []),
  ];
  const header = [oneLine(semantic.endpoint), ...tags.map((t) => c.dim(t))].join("  ");
  const lines = [`${c.bold(label)}  ${c.cyan("LLM ")}  ${header}`];
  const last = semantic.messages.at(-1);
  if (last !== undefined) lines.push(detailLine(indent, ">", last, c.dim));
  const { status } = step.response;
  const answer = status >= 200 && status <= 299 ? answerOf(step, semantic.api) : undefined;
  const ok = answer !== undefined ? answer.error === undefined : status >= 200 && status <= 299;
  for (const line of responseLines(answer, status)) {
    lines.push(detailLine(indent, "<", line, ok ? c.green : c.red));
  }
  return lines;
}

/**
 * Formats a recording as a timeline a person can read: a header with the
 * name, step count and format version, then each step with its number, the
 * last message sent and the answer (LLM) or the arguments and outcome (tool).
 * Control characters in recorded text are escaped, never printed.
 *
 * @param r - The recording.
 * @param opts - Formatting options.
 * @returns The text, ending in "\n".
 */
export function formatTimeline(r: Recording, opts: TimelineOptions = {}): string {
  const color = opts.color ?? shouldColor(undefined, process.env, process.stdout.isTTY === true);
  const c = pc.createColors(color);
  const count = `${r.steps.length} ${r.steps.length === 1 ? "step" : "steps"}`;
  const lines = [`${c.bold(oneLine(r.name))}  (${count}, format v${r.formatVersion})`, ""];
  const width = Math.max(2, String(r.steps.length).length);
  r.steps.forEach((step, i) => {
    lines.push(...stepLines(step, String(i + 1).padStart(width), c));
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the CLI.
 *
 * @param argv - The arguments after the script path, i.e. `process.argv.slice(2)`.
 * @returns The exit code: 0 ok, 1 unreadable or invalid file, 2 bad usage.
 */
export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`agent-retrace: ${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, file, ...rest] = parsed.positionals;
  if (command !== "inspect" || file === undefined || rest.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let recording: Recording;
  try {
    recording = parseRecording(await readFile(file, "utf8"), file);
  } catch (err) {
    const message =
      err instanceof RecordingFormatError
        ? err.message
        : `Cannot read ${file}: ${(err as Error).message}`;
    // The reason can quote the file's contents, so it is made safe too.
    process.stderr.write(`agent-retrace: ${oneLine(message)}\n`);
    return 1;
  }
  const color = shouldColor(parsed.color, process.env, process.stdout.isTTY === true);
  process.stdout.write(formatTimeline(recording, { color }));
  return 0;
}

/**
 * Parses the command line strictly.
 *
 * @param argv - The arguments after the script path.
 * @returns The positionals, whether help was asked for, and the color flag;
 *   of `--color` and `--no-color`, the last one given wins.
 * @throws {TypeError} On an unknown option, as `parseArgs` does.
 */
function parseCliArgs(argv: string[]): {
  positionals: string[];
  help: boolean;
  color: boolean | undefined;
} {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      color: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
    allowPositionals: true,
    tokens: true,
  });
  let color: boolean | undefined;
  for (const token of tokens) {
    if (token.kind === "option" && (token.name === "color" || token.name === "no-color")) {
      color = token.name === "color";
    }
  }
  return { positionals, help: values.help === true, color };
}

/**
 * Reports whether this module is the script Node was started with, like
 * Python's `if __name__ == "__main__"`. npm installs a `bin` as a symlink
 * (`node_modules/.bin/agent-retrace`), and Node resolves symlinks before
 * setting `import.meta.url`, so `argv[1]` is resolved the same way first.
 *
 * @returns True when run directly, false when imported.
 */
function isMainModule(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // `agent-retrace inspect x.json | head` closes the pipe early; that is not an error.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
  // Setting exitCode instead of calling process.exit() lets buffered output
  // to a pipe finish writing before Node exits.
  process.exitCode = await main(process.argv.slice(2));
}
