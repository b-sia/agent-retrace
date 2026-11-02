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
import { formatTimeline, main } from "../../src/cli.js";
import {
  type JsonValue,
  parseRecording,
  type Recording,
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

  test("shows a thrown tool outcome", () => {
    const text = formatTimeline(
      recording([
        {
          type: "tool",
          name: "issue_refund",
          args: ["A1", 30],
          outcome: { type: "throw", name: "RangeError", message: "amount too high\nretry later" },
        },
      ]),
      { color: false },
    );
    expect(text).toBe(
      [
        "inline  (1 step, format v1)",
        "",
        ' 1  tool  issue_refund("A1",30)',
        "        < throws RangeError: amount too high\\nretry later",
        "",
      ].join("\n"),
    );
  });

  test("shows a tool that returned nothing", () => {
    const text = formatTimeline(
      recording([{ type: "tool", name: "noop", args: [], outcome: { type: "return" } }]),
      { color: false },
    );
    expect(text).toContain(" 1  tool  noop()\n        < undefined\n");
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
  });

  test("does not split a character made of two code units", () => {
    const text = formatTimeline(recording([chatStep("😀".repeat(150), 500)]), { color: false });
    const request = text.split("\n")[3] ?? "";
    expect(request.endsWith("😀...")).toBe(true);
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

  test("pads step numbers to the widest one", () => {
    const steps: Step[] = Array.from({ length: 10 }, () => ({
      type: "tool" as const,
      name: "t",
      args: [],
      outcome: { type: "return" as const, value: 1 },
    }));
    const text = formatTimeline(recording(steps), { color: false });
    expect(text).toContain("\n 1  tool  t()\n");
    expect(text).toContain("\n10  tool  t()\n");
  });

  test("colors only when asked", async () => {
    const r = await fixture("openai-chat-stream");
    expect(formatTimeline(r, { color: true })).toContain("\u001b[");
    expect(formatTimeline(r, { color: false })).not.toContain("\u001b[");
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
