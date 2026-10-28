/**
 * Change report rendering: turns the first step where an agent stopped
 * matching its recording into text a person can read without docs. Pure apart
 * from reading the terminal's color support and the working directory as
 * defaults.
 */
import { isAbsolute, relative, sep } from "node:path";
import { diffArrays } from "diff";
import pc from "picocolors";
import type { JsonValue, RecordedRequest, Step } from "../recording/format.js";
import { stableStringify } from "../recording/format.js";
import { toSemantic } from "./semantic.js";

/** Everything needed to explain one mismatch. */
export interface ChangeReport {
  recordingName: string;
  /** Absolute path of the recording file. */
  recordingPath: string;
  /** A step that differs, a step the recording does not have, or a recorded step never made. */
  kind: "changed" | "extra" | "missing";
  /** 1-based position of the step. */
  stepNumber: number;
  /** Number of steps in the recording. */
  totalSteps: number;
  /** The recorded step; absent for "extra". */
  recorded?: Step;
  /** The step the agent made; absent for "missing". */
  live?: Step;
  /** Shell command that re-records from this step. */
  command: string;
}

/** Options for {@link renderChange}. */
export interface RenderOptions {
  /** Whether to emit ANSI colors. Defaults to whether the terminal supports them. */
  color?: boolean;
  /** Directory the recording path is shown relative to. Defaults to `process.cwd()`. */
  cwd?: string;
}

type Colors = ReturnType<typeof pc.createColors>;

// Unchanged lines kept on each side of a change in a line diff.
const CONTEXT = 3;

/**
 * Describes a step in a few words.
 *
 * @param step - The step.
 * @returns E.g. "LLM call (POST api.openai.com/v1/chat/completions)" or "tool `search`".
 */
export function describeStep(step: Step): string {
  return step.type === "llm"
    ? `LLM call (${toSemantic(step.request).endpoint})`
    : `tool \`${step.name}\``;
}

/**
 * Formats a JSON value on one line.
 *
 * @param value - The value.
 * @returns Compact JSON.
 */
function compact(value: JsonValue | undefined): string {
  return value === undefined ? "(none)" : JSON.stringify(value);
}

/**
 * Line-diffs two texts, keeping at most `CONTEXT` unchanged lines around each
 * change and writing a longer unchanged run as `...`. Lines are split on "\n"
 * and diffed as arrays, so a trailing newline shows up as an added or removed
 * empty line instead of two identical-looking lines.
 *
 * @param a - Old text.
 * @param b - New text.
 * @param c - Colors.
 * @param indent - Prefix for every output line.
 * @returns Output lines.
 */
function lineDiff(a: string, b: string, c: Colors, indent = ""): string[] {
  const out: string[] = [];
  const changes = diffArrays(a.split("\n"), b.split("\n"));
  changes.forEach((change, i) => {
    if (change.added || change.removed) {
      const mark = change.added ? c.green : c.red;
      const sign = change.added ? "+" : "-";
      for (const line of change.value) out.push(mark(`${indent}${sign} ${line}`));
      return;
    }
    const lines = change.value;
    const head = i === 0 ? 0 : CONTEXT;
    const tail = i === changes.length - 1 ? 0 : CONTEXT;
    // Collapsing a single line would not save any space.
    if (lines.length <= head + tail + 1) {
      for (const line of lines) out.push(`${indent}  ${line}`);
      return;
    }
    for (const line of lines.slice(0, head)) out.push(`${indent}  ${line}`);
    out.push(`${indent}  ...`);
    for (const line of lines.slice(lines.length - tail)) out.push(`${indent}  ${line}`);
  });
  return out;
}

/**
 * Diffs rendered message lines, showing added and removed lines and a count
 * for each unchanged run.
 *
 * @param a - Old lines.
 * @param b - New lines.
 * @param c - Colors.
 * @returns Output lines.
 */
function messagesDiff(a: string[], b: string[], c: Colors): string[] {
  const out: string[] = [];
  for (const change of diffArrays(a, b)) {
    if (change.added) for (const line of change.value) out.push(c.green(`+ ${line}`));
    else if (change.removed) for (const line of change.value) out.push(c.red(`- ${line}`));
    else out.push(c.dim(`  (${change.value.length} unchanged)`));
  }
  return out;
}

/**
 * Diffs two string-keyed maps of JSON values as `+ key: v`, `- key: v` and
 * `~ key: old -> new` lines, in key order.
 *
 * @param a - Old entries.
 * @param b - New entries.
 * @param c - Colors.
 * @param show - Formats one value.
 * @returns Output lines.
 */
function entriesDiff(
  a: Record<string, JsonValue | undefined>,
  b: Record<string, JsonValue | undefined>,
  c: Colors,
  show: (value: JsonValue | undefined) => string = compact,
): string[] {
  const out: string[] = [];
  for (const key of sortedKeys(a, b)) {
    const [va, vb] = [a[key], b[key]];
    if (va === undefined) out.push(c.green(`+ ${key}: ${show(vb)}`));
    else if (vb === undefined) out.push(c.red(`- ${key}: ${show(va)}`));
    else if (!sameJson(va, vb)) out.push(c.yellow(`~ ${key}: ${show(va)} -> ${show(vb)}`));
  }
  return out;
}

/**
 * Diffs tool definitions by name: added, removed, or changed schema with an
 * indented line diff of the schemas.
 *
 * @param a - Old tools.
 * @param b - New tools.
 * @param c - Colors.
 * @returns Output lines.
 */
function toolsDiff(a: Map<string, JsonValue>, b: Map<string, JsonValue>, c: Colors): string[] {
  const out: string[] = [];
  for (const name of sortedKeys(Object.fromEntries(a), Object.fromEntries(b))) {
    const [sa, sb] = [a.get(name), b.get(name)];
    if (sa === undefined) out.push(c.green(`+ added ${name}`));
    else if (sb === undefined) out.push(c.red(`- removed ${name}`));
    else if (!sameJson(sa, sb)) {
      out.push(c.yellow(`~ changed ${name} (schema)`), ...lineDiff(json(sa), json(sb), c, "    "));
    }
  }
  return out;
}

/**
 * Returns the keys of two objects, deduplicated and sorted by code unit.
 *
 * @param a - First object.
 * @param b - Second object.
 * @returns The keys.
 */
function sortedKeys(a: object, b: object): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
}

/**
 * Pretty-prints a value with stable key order, without the trailing newline.
 *
 * @param value - The value.
 * @returns The JSON text.
 */
function json(value: unknown): string {
  return stableStringify(value).slice(0, -1);
}

/**
 * Compares two JSON values, ignoring key order.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns True when they are equal.
 */
function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Builds a titled section, or nothing when it has no lines.
 *
 * @param title - The section title.
 * @param lines - The section body.
 * @param c - Colors.
 * @returns Zero or one sections.
 */
function section(title: string, lines: string[], c: Colors): string[][] {
  return lines.length === 0 ? [] : [[c.bold(`${title}:`), ...lines]];
}

/**
 * Sections for two LLM requests: what changed in meaning, or a raw body diff
 * when the meaningful parts are equal but the requests are not (an unknown
 * API, or a change inside content the semantic view summarizes).
 *
 * @param a - The recorded request.
 * @param b - The live request.
 * @param c - Colors.
 * @returns The sections.
 */
function llmSections(a: RecordedRequest, b: RecordedRequest, c: Colors): string[][] {
  const sa = toSemantic(a);
  const sb = toSemantic(b);
  const sections: string[][] = [];
  if (sa.endpoint !== sb.endpoint) {
    sections.push([c.yellow(`Endpoint: ${sa.endpoint} -> ${sb.endpoint}`)]);
  }
  sections.push(...section("Headers", entriesDiff(a.headers, b.headers, c, String), c));
  if (sa.model !== sb.model) {
    sections.push([c.yellow(`Model: ${sa.model ?? "(none)"} -> ${sb.model ?? "(none)"}`)]);
  }
  if (sa.api !== "unknown" && sa.api === sb.api) {
    const system = sa.system === sb.system ? [] : lineDiff(sa.system, sb.system, c);
    const messages = sameJson(sa.messages, sb.messages)
      ? []
      : messagesDiff(sa.messages, sb.messages, c);
    sections.push(...section("System prompt", system, c), ...section("Messages", messages, c));
    sections.push(...section("Tools", toolsDiff(sa.tools, sb.tools, c), c));
    sections.push(...section("Params", entriesDiff(sa.params, sb.params, c), c));
  }
  const payload = (r: RecordedRequest) => json(r.text ?? r.body ?? null);
  if (sections.length === 0 && payload(a) !== payload(b)) {
    sections.push(...section("Request body", lineDiff(payload(a), payload(b), c), c));
  }
  return sections;
}

/**
 * Sections explaining how a live step differs from its recording.
 *
 * @param a - The recorded step.
 * @param b - The live step.
 * @param c - Colors.
 * @returns The sections.
 */
function changeSections(a: Step, b: Step, c: Colors): string[][] {
  if (a.type === "llm" && b.type === "llm") return llmSections(a.request, b.request, c);
  if (a.type === "tool" && b.type === "tool") {
    const sections: string[][] = [];
    if (a.name !== b.name) sections.push([c.yellow(`Tool: ${a.name} -> ${b.name}`)]);
    if (!sameJson(a.args, b.args)) {
      sections.push(...section("Arguments", lineDiff(json(a.args), json(b.args), c), c));
    }
    return sections;
  }
  return [[c.yellow(`Step type: ${describeStep(a)} -> ${describeStep(b)}`)]];
}

/**
 * Writes a path relative to `cwd` with "/" separators, or as given when it
 * lies outside `cwd`.
 *
 * @param path - An absolute path.
 * @param cwd - The base directory.
 * @returns The path to show.
 */
function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}

/**
 * Renders a change report.
 *
 * @param report - The report.
 * @param opts - Color and base directory.
 * @returns Multi-line text, without a trailing newline.
 */
export function renderChange(report: ChangeReport, opts: RenderOptions = {}): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const { recorded, live, stepNumber: n, totalSteps: total } = report;
  let header: string;
  let sections: string[][] = [];
  if (report.kind === "extra" || recorded === undefined) {
    const what = live ? describeStep(live) : "unknown step";
    header = `Your agent made more calls than recorded: step ${n} is new (recording has ${total} steps): ${what}`;
  } else if (report.kind === "missing" || live === undefined) {
    header = `Your agent made fewer calls than recorded: step ${n} of ${total} was never made: ${describeStep(recorded)}`;
  } else {
    header = `Your agent changed at step ${n} of ${total}: ${describeStep(recorded)}`;
    sections = changeSections(recorded, live, c);
  }
  const blocks = [
    [`agent-retrace: recording "${report.recordingName}" no longer matches.`, c.bold(header)],
    ...sections,
    [
      `Recording: ${displayPath(report.recordingPath, opts.cwd ?? process.cwd())}`,
      `To accept this change and re-record from step ${n}, run:`,
      `  ${report.command}`,
    ],
  ];
  return blocks.map((lines) => lines.join("\n")).join("\n\n");
}
