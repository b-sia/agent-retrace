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
import { toolCallLine, toSemantic } from "./diff/semantic.js";
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
import { asArray, asString, isObject, type JsonValue } from "./recording/json.js";
import { type Colors, oneLine } from "./terminal.js";

/** Options for {@link formatTimeline}. */
export interface TimelineOptions {
  /** Whether to emit ANSI colors. Defaults to whether the terminal supports them. */
  color?: boolean;
}

/** What an assistant answered: its text and the tools it asked for. */
interface Answer {
  text: string;
  calls: { name: JsonValue | undefined; args: JsonValue | undefined }[];
}

const USAGE = "Usage: agent-retrace inspect <file>";
const HELP = `${USAGE}

Prints a recording as a timeline: one entry per step, with the last message
sent and the answer for LLM calls, and the arguments and outcome for tools.

Exit codes: 0 ok, 1 unreadable or invalid file, 2 bad usage.
`;

// Longest summary shown on one line, "..." included.
const MAX_SUMMARY = 100;
// Detail lines sit under the step's label.
const DETAIL_INDENT = " ".repeat(8);

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
 * Reads an OpenAI Chat Completions message (`choices[0].message`, or the
 * same shape rebuilt from stream deltas).
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
 * Rebuilds an OpenAI Chat Completions message from streamed chunks: text
 * deltas are concatenated, and tool call fragments are joined by `index`.
 *
 * @param events - The stream's events.
 * @returns The answer.
 */
function chatStreamAnswer(events: SseEvent[]): Answer {
  let text = "";
  const calls: { name: string; args: string }[] = [];
  for (const { data } of events) {
    const choice = isObject(data) ? asArray(data.choices)[0] : undefined;
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
  return { text, calls: calls.filter((call) => call !== undefined) };
}

/**
 * Reads the `output` items of an OpenAI Responses API response.
 *
 * @param output - The output items.
 * @returns The answer.
 */
function responsesAnswer(output: JsonValue[]): Answer {
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
 * Rebuilds an OpenAI Responses API answer from its stream: the output of the
 * final `response.completed` event, else the items announced as done, else
 * the concatenated text deltas of a stream that was cut short.
 *
 * @param events - The stream's events.
 * @returns The answer.
 */
function responsesStreamAnswer(events: SseEvent[]): Answer {
  const data = events.map((e) => (isObject(e.data) ? e.data : {}));
  const completed = data.findLast((d) => d.type === "response.completed");
  if (completed !== undefined && isObject(completed.response)) {
    return responsesAnswer(asArray(completed.response.output));
  }
  const done = data.filter((d) => d.type === "response.output_item.done").map((d) => d.item ?? {});
  if (done.length > 0) return responsesAnswer(done);
  const text = data
    .filter((d) => d.type === "response.output_text.delta")
    .map((d) => asString(d.delta) ?? "")
    .join("");
  return { text, calls: [] };
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
 * or partial tool input JSON to it.
 *
 * @param events - The stream's events.
 * @returns The answer.
 */
function anthropicStreamAnswer(events: SseEvent[]): Answer {
  const blocks: { type: string; name?: JsonValue; text: string }[] = [];
  for (const { data } of events) {
    if (!isObject(data) || typeof data.index !== "number") continue;
    if (data.type === "content_block_start" && isObject(data.content_block)) {
      const block = data.content_block;
      // A tool_use block starts with an empty `input` that the deltas fill in.
      blocks[data.index] = {
        type: asString(block.type) ?? "",
        name: block.name,
        text: asString(block.text) ?? "",
      };
    } else if (data.type === "content_block_delta" && isObject(data.delta)) {
      const block = blocks[data.index];
      if (block === undefined) continue;
      block.text += (asString(data.delta.text) ?? "") + (asString(data.delta.partial_json) ?? "");
    }
  }
  const answer: Answer = { text: "", calls: [] };
  for (const block of blocks) {
    if (block?.type === "text") answer.text += block.text;
    if (block?.type === "tool_use") answer.calls.push({ name: block.name, args: block.text });
  }
  return answer;
}

/**
 * Works out what the assistant answered in an LLM step, for the three
 * provider APIs the semantic view understands, streamed or not.
 *
 * @param step - The LLM step.
 * @returns The answer, or undefined for another API or a non-2xx response.
 */
function answerOf(step: LlmStep): Answer | undefined {
  const { response } = step;
  if (response.status < 200 || response.status > 299) return undefined;
  const { api } = toSemantic(step.request);
  const body = isObject(response.body) ? response.body : undefined;
  const events = response.events;
  if (api === "openai-chat") {
    if (events !== undefined) return chatStreamAnswer(events);
    const choice = asArray(body?.choices)[0];
    return body && chatAnswer(isObject(choice) ? choice.message : undefined);
  }
  if (api === "openai-responses") {
    if (events !== undefined) return responsesStreamAnswer(events);
    return body && responsesAnswer(asArray(body.output));
  }
  if (api === "anthropic-messages") {
    if (events !== undefined) return anthropicStreamAnswer(events);
    return body && anthropicAnswer(asArray(body.content));
  }
  return undefined;
}

/**
 * Summarizes an LLM response: one line for the text and one per tool call,
 * or the HTTP status when there is no answer to show.
 *
 * @param step - The LLM step.
 * @returns The summary lines, without the "< " marker.
 */
function responseLines(step: LlmStep): string[] {
  const answer = answerOf(step);
  const lines: string[] = [];
  if (answer !== undefined && answer.text !== "") {
    lines.push(`assistant: ${oneLine(answer.text)}`);
  }
  for (const call of answer?.calls ?? []) lines.push(toolCallLine(call.name, call.args));
  return lines.length > 0 ? lines : [`HTTP ${step.response.status}`];
}

/**
 * Formats a thrown error on one line.
 *
 * @param error - The recorded error.
 * @returns E.g. "throws TypeError: boom".
 */
function thrown(error: RecordedError): string {
  return `throws ${oneLine(`${error.name}: ${error.message}`)}`;
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
  const detail = (mark: string, text: string, color: (s: string) => string): string =>
    color(`${DETAIL_INDENT}${mark} ${truncate(text)}`);
  if (step.type === "tool") {
    const call = truncate(`${step.name}(${step.args.map(stableStringifyLine).join(",")})`);
    const outcome = step.outcome;
    const result =
      outcome.type === "throw"
        ? detail("<", thrown(outcome), c.red)
        : detail(
            "<",
            outcome.value === undefined ? "undefined" : stableStringifyLine(outcome.value),
            c.green,
          );
    return [`${c.bold(label)}  ${c.magenta("tool")}  ${call}`, result];
  }
  const semantic = toSemantic(step.request);
  const body = isObject(step.request.body) ? step.request.body : {};
  const tags = [
    ...(semantic.model !== undefined ? [`model=${semantic.model}`] : []),
    ...(body.stream === true || step.response.events !== undefined ? ["stream"] : []),
  ];
  const header = [semantic.endpoint, ...tags.map((t) => c.dim(t))].join("  ");
  const lines = [`${c.bold(label)}  ${c.cyan("LLM ")}  ${header}`];
  const last = semantic.messages.at(-1);
  if (last !== undefined) lines.push(detail(">", last, c.dim));
  const ok = step.response.status >= 200 && step.response.status <= 299;
  for (const line of responseLines(step)) lines.push(detail("<", line, ok ? c.green : c.red));
  return lines;
}

/**
 * Formats a recording as a timeline a person can read: a header with the
 * name, step count and format version, then each step with its number, the
 * last message sent and the answer (LLM) or the arguments and outcome (tool).
 *
 * @param r - The recording.
 * @param opts - Formatting options.
 * @returns The text, ending in "\n".
 */
export function formatTimeline(r: Recording, opts: TimelineOptions = {}): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const count = `${r.steps.length} ${r.steps.length === 1 ? "step" : "steps"}`;
  const lines = [`${c.bold(r.name)}  (${count}, format v${r.formatVersion})`, ""];
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
  let values: { help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    }));
  } catch (err) {
    process.stderr.write(`agent-retrace: ${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, file, ...rest] = positionals;
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
    process.stderr.write(`agent-retrace: ${message}\n`);
    return 1;
  }
  // Colors only on a terminal, so piping to a file or `less` gets plain text.
  const color = process.stdout.isTTY === true && pc.isColorSupported;
  process.stdout.write(formatTimeline(recording, { color }));
  return 0;
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
