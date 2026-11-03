/**
 * The `agent-retrace inspect` CLI: the timeline text, the exit codes of
 * `main()`, and the built file run as a real process, directly and through a
 * symlink the way npm installs a `bin`.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { formatTimeline, main, shouldColor } from "../../src/cli.js";
import {
  type JsonValue,
  parseRecording,
  type Recording,
  type SseEvent,
  type Step,
} from "../../src/recording/format.js";

const run = promisify(execFile);
const FIXTURES = resolve(import.meta.dirname, "fixtures");
const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Loads a fixture recording.
 *
 * @param name - The fixture name without `.json`.
 * @returns The parsed recording.
 */
async function fixture(name: string): Promise<Recording> {
  const path = join(FIXTURES, `${name}.json`);
  return parseRecording(await readFile(path, "utf8"), path);
}

/**
 * Builds a recording from steps.
 *
 * @param steps - The steps.
 * @returns The recording.
 */
function recording(steps: Step[]): Recording {
  return { formatVersion: 1, name: "inline", steps };
}

/**
 * Builds an OpenAI Chat Completions step with a JSON response body.
 *
 * @param userText - The last user message.
 * @param status - The response status.
 * @param body - The response body.
 * @returns The step.
 */
function chatStep(userText: string, status: number, body: JsonValue = {}): Step {
  return {
    type: "llm",
    request: {
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      body: { model: "gpt-x", messages: [{ role: "user", content: userText }] },
    },
    response: { status, headers: {}, body },
  };
}

/**
 * Builds a streamed LLM step for one provider API.
 *
 * @param url - The request URL, which decides the API.
 * @param data - The data of each stream event, in order.
 * @param headers - Request headers.
 * @returns The step.
 */
function streamStep(url: string, data: JsonValue[], headers: Record<string, string> = {}): Step {
  const events: SseEvent[] = data.map((d) => ({ data: d }));
  return {
    type: "llm",
    request: {
      method: "POST",
      url,
      headers,
      body: { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
    },
    response: { status: 200, headers: {}, events },
  };
}

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const CHAT = "https://api.openai.com/v1/chat/completions";
const RESPONSES = "https://api.openai.com/v1/responses";

describe("formatTimeline", () => {
  test("renders a streamed OpenAI chat recording exactly", async () => {
    const text = formatTimeline(await fixture("openai-chat-stream"), { color: false });
    expect(text).toBe(
      [
        "openai-chat-stream  (3 steps, format v1)",
        "",
        " 1  LLM   POST api.openai.com/v1/chat/completions  model=gpt-x  stream",
        "        > user: My order arrived broken",
        '        < assistant -> tool_call lookup_order({"orderId":"A1"})',
        ' 2  tool  lookup_order({"orderId":"A1"})',
        '        < {"status":"delivered","damaged":true,"orderId":"A1"}',
        " 3  LLM   POST api.openai.com/v1/chat/completions  model=gpt-x  stream",
        '        > tool_result(call_A1): {"status":"delivered","damaged":true,"orderId":"A1"}',
        "        < assistant: Sorry about that! I have issued a full refund for order A1.",
        "",
      ].join("\n"),
    );
  });

  test.each([
    ["openai-chat", false],
    ["openai-responses-stream", true],
    ["anthropic-stream", true],
  ])("reconstructs the answers of %s", async (name, stream) => {
    const text = formatTimeline(await fixture(name), { color: false });
    const lines = text.split("\n");
    expect(lines[2]).toMatch(/^ 1 {2}LLM {3}POST api\.(openai|anthropic)\.com\/v1\//);
    expect(lines[2]?.endsWith("  stream")).toBe(stream);
    expect(text).toContain(
      '\n        < assistant -> tool_call lookup_order({"orderId":"A1"})\n 2  tool  lookup_order(',
    );
    expect(text).toContain(
      "        < assistant: Sorry about that! I have issued a full refund for order A1.\n",
    );
  });

  test("shows a thrown tool outcome and a tool that returned nothing", () => {
    const text = formatTimeline(
      recording([
        {
          type: "tool",
          name: "issue_refund",
          args: ["A1", 30],
          outcome: { type: "throw", name: "RangeError", message: "amount too high\nretry later" },
        },
        { type: "tool", name: "noop", args: [], outcome: { type: "return" } },
      ]),
      { color: false },
    );
    expect(text).toBe(
      [
        "inline  (2 steps, format v1)",
        "",
        ' 1  tool  issue_refund("A1",30)',
        "        < throws RangeError: amount too high\\nretry later",
        " 2  tool  noop()",
        "        < undefined",
        "",
      ].join("\n"),
    );
  });

  test("truncates long summaries to 100 characters", () => {
    const long = "x".repeat(300);
    const text = formatTimeline(
      recording([
        chatStep(long, 200, {
          choices: [{ message: { role: "assistant", content: long } }],
        }),
        { type: "tool", name: "t", args: [long], outcome: { type: "return", value: long } },
      ]),
      { color: false },
    );
    const lines = text.split("\n").filter((l) => l.startsWith("        ") || l.startsWith(" 2"));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const summary = line.replace(/^ {8}[<>] | 2 {2}tool {2}/, "");
      expect(summary).toHaveLength(100);
      expect(summary.endsWith("...")).toBe(true);
    }
    // A character made of two code units is never split.
    const emoji = formatTimeline(recording([chatStep("😀".repeat(150), 500)]), { color: false });
    expect(emoji.split("\n")[3]?.endsWith("😀...")).toBe(true);
  });

  test("falls back to the HTTP status for errors and unknown APIs", () => {
    const unknown: Step = {
      type: "llm",
      request: { method: "GET", url: "https://llm.example.com/v1/models", headers: {} },
      response: { status: 200, headers: {}, body: { data: [] } },
    };
    const text = formatTimeline(
      recording([chatStep("hi", 500, { error: { message: "boom" } }), unknown]),
      { color: false },
    );
    expect(text).toContain("        > user: hi\n        < HTTP 500\n");
    expect(text).toContain(" 2  LLM   GET llm.example.com/v1/models\n        < HTTP 200\n");
  });

  test("escapes control characters from the recording instead of printing them", () => {
    const evil: Recording = {
      formatVersion: 1,
      name: "evil\u001b[2J\u001b]0;pwned\u0007",
      steps: [
        {
          type: "llm",
          request: {
            method: "POST",
            url: CHAT,
            headers: {},
            body: {
              model: "gpt\u001b[31m",
              messages: [{ role: "user", content: "hello\rOVERWRITE\ttab" }],
            },
          },
          response: {
            status: 200,
            headers: {},
            body: {
              choices: [
                {
                  message: {
                    content: "ok\u001b[2K\u009b2J",
                    tool_calls: [{ function: { name: "t\u001bx", arguments: "{}" } }],
                  },
                },
              ],
            },
          },
        },
        {
          type: "tool",
          name: "run\u001b[1A",
          args: [],
          outcome: { type: "throw", name: "Error", message: "bad\u001b[2J\rend" },
        },
      ],
    };
    const text = formatTimeline(evil, { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking none are printed.
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(text).toBe(
      [
        "evil\\u001b[2J\\u001b]0;pwned\\u0007  (2 steps, format v1)",
        "",
        " 1  LLM   POST api.openai.com/v1/chat/completions  model=gpt\\u001b[31m",
        "        > user: hello\\rOVERWRITE\\ttab",
        "        < assistant: ok\\u001b[2K\\u009b2J",
        "        < assistant -> tool_call t\\u001bx({})",
        " 2  tool  run\\u001b[1A()",
        "        < throws Error: bad\\u001b[2J\\rend",
        "",
      ].join("\n"),
    );
  });

  test("shows a streamed Anthropic tool call with no arguments as {}", () => {
    const text = formatTimeline(
      recording([
        streamStep(ANTHROPIC, [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "t1", name: "noargs", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "" },
          },
          { type: "content_block_stop", index: 0 },
        ]),
      ]),
      { color: false },
    );
    expect(text).toContain("        < assistant -> tool_call noargs({})\n");
  });

  test("keeps the input a streamed Anthropic tool call started with when no deltas follow", () => {
    const text = formatTimeline(
      recording([
        streamStep(ANTHROPIC, [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
          },
        ]),
      ]),
      { color: false },
    );
    expect(text).toContain('        < assistant -> tool_call f({"a":1})\n');
  });

  test("reads only the first choice of a streamed chat answer with n > 1", () => {
    const chunk = (index: number, delta: JsonValue): JsonValue => ({ choices: [{ index, delta }] });
    const text = formatTimeline(
      recording([
        streamStep(CHAT, [
          chunk(0, { content: "Hel" }),
          chunk(1, { content: "Bye" }),
          chunk(0, { content: "lo" }),
          chunk(0, { tool_calls: [{ index: 0, function: { name: "f", arguments: '{"a":' } }] }),
          chunk(1, { tool_calls: [{ index: 0, function: { name: "g", arguments: '{"z":' } }] }),
          chunk(0, { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
          chunk(1, { tool_calls: [{ index: 0, function: { arguments: "2}" } }] }),
        ]),
      ]),
      { color: false },
    );
    expect(text).toContain(
      '        < assistant: Hello\n        < assistant -> tool_call f({"a":1})\n',
    );
    expect(text).not.toContain("Bye");
  });

  test.each([
    [
      "an Anthropic error event",
      streamStep(ANTHROPIC, [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
      ["assistant: Partial", "error: overloaded_error: Overloaded"],
    ],
    [
      "a failed Responses stream",
      streamStep(RESPONSES, [
        { type: "response.output_text.delta", delta: "Partial" },
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "server_error", message: "boom" },
            output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }] }],
          },
        },
      ]),
      ["assistant: Partial", "error: server_error: boom"],
    ],
    [
      "an incomplete Responses stream",
      streamStep(RESPONSES, [
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [{ type: "message", content: [{ type: "output_text", text: "Cut" }] }],
          },
        },
      ]),
      ["assistant: Cut", "error: incomplete: max_output_tokens"],
    ],
    [
      "a Responses error event",
      streamStep(RESPONSES, [{ type: "error", code: "rate_limit", message: "slow down" }]),
      ["error: rate_limit: slow down"],
    ],
    [
      "a chat stream error chunk",
      streamStep(CHAT, [
        { choices: [{ index: 0, delta: { content: "Partial" } }] },
        { error: { type: "server_error", message: "upstream died" } },
      ]),
      ["assistant: Partial", "error: server_error: upstream died"],
    ],
  ])("shows %s in red although the status is 200", (_, step, expected) => {
    const plain = formatTimeline(recording([step]), { color: false });
    expect(plain).toContain(expected.map((line) => `        < ${line}\n`).join(""));
    const colored = formatTimeline(recording([step]), { color: true });
    const red = colored.split("\n").filter((l) => l.includes("< "));
    expect(red).toHaveLength(expected.length);
    for (const line of red) expect(line.startsWith("\u001b[31m")).toBe(true);
  });

  test("pads step numbers to the widest and keeps details under the step content", () => {
    const steps: Step[] = Array.from({ length: 100 }, () => ({
      type: "tool" as const,
      name: "t",
      args: [],
      outcome: { type: "return" as const, value: 1 },
    }));
    const text = formatTimeline(recording(steps), { color: false });
    expect(text).toContain("\n  1  tool  t()\n         < 1\n");
    expect(text).toContain("\n100  tool  t()\n         < 1\n");
  });

  test("writes a tool call's arguments in the same key order as the tool step", () => {
    const text = formatTimeline(
      recording([
        chatStep("find x", 200, {
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "search", arguments: '{"query":"x","type":"web"}' } },
                ],
              },
            },
          ],
        }),
        {
          type: "tool",
          name: "search",
          args: [{ query: "x", type: "web" }],
          outcome: { type: "return", value: [] },
        },
      ]),
      { color: false },
    );
    expect(text).toContain(
      '        < assistant -> tool_call search({"type":"web","query":"x"})\n' +
        ' 2  tool  search({"type":"web","query":"x"})\n',
    );
  });

  test("colors only when asked", async () => {
    const r = await fixture("openai-chat-stream");
    expect(formatTimeline(r, { color: true })).toContain("\u001b[");
    expect(formatTimeline(r, { color: false })).not.toContain("\u001b[");
  });
});

describe("shouldColor", () => {
  test.each([
    ["a terminal", {}, true, true],
    ["a pipe", {}, false, false],
    ["a dumb terminal", { TERM: "dumb" }, true, false],
    ["NO_COLOR on a terminal", { NO_COLOR: "1" }, true, false],
    ["an empty NO_COLOR", { NO_COLOR: "" }, true, true],
    ["FORCE_COLOR on a pipe", { FORCE_COLOR: "1" }, false, true],
    ["an empty FORCE_COLOR on a pipe", { FORCE_COLOR: "" }, false, true],
    ["FORCE_COLOR=0 on a terminal", { FORCE_COLOR: "0" }, true, false],
    ["FORCE_COLOR=false on a terminal", { FORCE_COLOR: "false" }, true, false],
    ["NO_COLOR and FORCE_COLOR", { NO_COLOR: "1", FORCE_COLOR: "1" }, false, false],
  ])("%s", (_, env, isTTY, expected) => {
    expect(shouldColor(undefined, env, isTTY)).toBe(expected);
  });

  test("a flag beats the environment", () => {
    expect(shouldColor(true, { NO_COLOR: "1" }, false)).toBe(true);
    expect(shouldColor(false, { FORCE_COLOR: "1" }, true)).toBe(false);
  });
});

describe("main", () => {
  let out: string;
  let err: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-retrace-cli-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Runs `main` with stdout and stderr captured.
   *
   * @param argv - The arguments.
   * @returns The exit code.
   */
  async function runMain(argv: string[]): Promise<number> {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    return await main(argv);
  }

  test("inspect prints the timeline and exits 0", async () => {
    expect(await runMain(["inspect", join(FIXTURES, "openai-chat.json")])).toBe(0);
    expect(out).toContain("openai-chat  (3 steps, format v1)");
    expect(out).toContain(" 1  LLM   POST");
    expect(err).toBe("");
  });

  test("a missing file exits 1", async () => {
    const missing = join(dir, "nope.json");
    expect(await runMain(["inspect", missing])).toBe(1);
    expect(err).toContain(missing);
    expect(out).toBe("");
  });

  test("an invalid file exits 1 with the format error", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, '{"formatVersion": 1, "name": "x", "steps": [{"type": "nope"}]}');
    expect(await runMain(["inspect", bad])).toBe(1);
    expect(err).toContain(`Invalid recording file ${bad}: step 1 has unknown type "nope"`);
  });

  test.each([
    [[]],
    [["inspect"]],
    [["inspect", "a.json", "b.json"]],
    [["frob", "a.json"]],
    [["inspect", "a.json", "--nope"]],
  ])("bad usage %j exits 2", async (argv) => {
    expect(await runMain(argv)).toBe(2);
    expect(err).toContain("Usage: agent-retrace inspect <file>");
    expect(out).toBe("");
  });

  test.each([
    [["inspect", "--color", "F"], true],
    [["inspect", "F", "--no-color"], false],
    [["--no-color", "inspect", "F", "--color"], true],
    [["--color", "inspect", "F", "--no-color"], false],
  ])("%j sets colors", async (argv, colored) => {
    const file = join(FIXTURES, "openai-chat.json");
    expect(await runMain(argv.map((a) => (a === "F" ? file : a)))).toBe(0);
    expect(out.includes("\u001b[")).toBe(colored);
  });

  test.each([[["--help"]], [["-h"]], [["inspect", "--help"]]])(
    "%j prints usage and exits 0",
    async (argv) => {
      expect(await runMain(argv)).toBe(0);
      expect(out).toContain("Usage: agent-retrace inspect <file>");
      expect(err).toBe("");
    },
  );
});

describe("built CLI", () => {
  let build: string;

  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), "agent-retrace-cli-build-"));
    await run(
      process.execPath,
      [
        join(ROOT, "node_modules/typescript/bin/tsc"),
        "-p",
        join(ROOT, "tsconfig.build.json"),
        "--outDir",
        join(build, "dist"),
      ],
      { cwd: ROOT },
    );
    // A package.json with "type": "module" makes Node load the output as ESM.
    await writeFile(join(build, "package.json"), '{"type": "module"}');
    // The runtime dependencies, as an install would provide them.
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    await mkdir(join(build, "node_modules"));
    for (const dep of Object.keys(pkg.dependencies)) {
      await symlink(join(ROOT, "node_modules", dep), join(build, "node_modules", dep), "dir");
    }
  }, 60_000);

  afterAll(async () => {
    await rm(build, { recursive: true, force: true });
  });

  test("node dist/cli.js inspect <fixture> exits 0", async () => {
    const { stdout } = await run(process.execPath, [
      join(build, "dist/cli.js"),
      "inspect",
      join(FIXTURES, "anthropic-stream.json"),
    ]);
    expect(stdout).toContain("anthropic-stream  (3 steps, format v1)");
    // Not a terminal, so no colors.
    expect(stdout).not.toContain("\u001b[");
  });

  test("FORCE_COLOR colors a pipe, NO_COLOR does not, and --color beats NO_COLOR", async () => {
    const args = [join(build, "dist/cli.js"), "inspect", join(FIXTURES, "openai-chat.json")];
    const env = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined };
    const forced = await run(process.execPath, args, { env: { ...env, FORCE_COLOR: "1" } });
    expect(forced.stdout).toContain("\u001b[");
    const flagged = await run(process.execPath, [...args, "--color"], {
      env: { ...env, NO_COLOR: "1" },
    });
    expect(flagged.stdout).toContain("\u001b[");
    const none = await run(process.execPath, args, { env: { ...env, NO_COLOR: "1" } });
    expect(none.stdout).not.toContain("\u001b[");
  });

  test("runs through an npm-style bin symlink", async () => {
    const bin = join(build, "node_modules/.bin");
    await mkdir(bin, { recursive: true });
    await chmod(join(build, "dist/cli.js"), 0o755);
    await symlink(join(build, "dist/cli.js"), join(bin, "agent-retrace"));
    const { stdout } = await run(join(bin, "agent-retrace"), [
      "inspect",
      join(FIXTURES, "openai-chat-stream.json"),
    ]);
    expect(stdout).toContain(" 2  tool  lookup_order");
  });

  test("a bad file exits 1 as a process", async () => {
    await expect(
      run(process.execPath, [join(build, "dist/cli.js"), "inspect", join(build, "missing.json")]),
    ).rejects.toMatchObject({ code: 1 });
  });

  test("importing the module does not run the CLI", async () => {
    const url = new URL(`file://${join(build, "dist/cli.js")}`).href;
    const { stdout, stderr } = await run(process.execPath, [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(url)}); console.log(typeof m.main, process.exitCode);`,
    ]);
    expect(stdout).toBe("function undefined\n");
    expect(stderr).toBe("");
  });
});
