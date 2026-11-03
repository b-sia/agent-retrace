/**
 * Integration tests for `recordTool()`.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetConfig } from "../../src/config.js";
import {
  ChangeDetectedError,
  configure,
  type Recording,
  ReplayUsageError,
  recordTool,
  replay,
} from "../../src/index.js";
import { chat, echoHandler } from "../support/agent.js";
import { startServer, type TestServer } from "../support/http-server.js";

let server: TestServer;
let dir: string;

beforeEach(async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
  server = await startServer(echoHandler);
  configure({ providerHosts: [server.host] });
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-tools-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetConfig();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Reads the steps of a saved recording.
 *
 * @param name - Recording name.
 * @returns Its steps.
 */
function stepsOf(name: string): Recording["steps"] {
  return (JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Recording).steps;
}

test("wrapped tool recorded, then replayed without running", async () => {
  const impl = vi.fn(async (q: string) => ({ hits: [q, q.length] }));
  const search = recordTool("search", impl);
  const first = await replay("t1", () => search("shoes"), { dir });
  const second = await replay("t1", () => search("shoes"), { dir });
  expect(impl).toHaveBeenCalledTimes(1);
  expect(first).toEqual({ hits: ["shoes", 5] });
  expect(second).toEqual(first);
});

test("a tool returning undefined replays as undefined", async () => {
  const impl = vi.fn(() => undefined);
  const log = recordTool("log", impl);
  await replay("t-undef", () => log(), { dir });
  expect(await replay("t-undef", () => log(), { dir })).toBeUndefined();
  expect(impl).toHaveBeenCalledTimes(1);
});

test("wrapped tool error replays as thrown Error with same name and message", async () => {
  const impl = vi.fn(async () => {
    throw new RangeError("out of stock");
  });
  const order = recordTool("order", impl);
  // Agents hand tool errors back to the model; a body that throws is not saved.
  const run = () => replay("t2", () => order().catch((e: unknown) => e), { dir });
  const recorded = (await run()) as Error;
  expect(recorded).toBeInstanceOf(RangeError);
  const err = (await run()) as Error;
  expect(impl).toHaveBeenCalledTimes(1);
  expect(err).toBeInstanceOf(RangeError);
  expect(err.name).toBe("RangeError");
  expect(err.message).toBe("out of stock");
});

test("tool args change reports `tool \\`search\\``", async () => {
  const search = recordTool("search", async (q: string) => q.toUpperCase());
  await replay("t3", () => search("shoes"), { dir });
  const err = (await replay("t3", () => search("boots"), { dir }).catch(
    (e: unknown) => e,
  )) as Error;
  expect(err).toBeInstanceOf(ChangeDetectedError);
  expect(err.message).toContain("tool `search`");
  expect(err.message).toContain("shoes");
  expect(err.message).toContain("boots");
});

test("unwrapped use outside replay() calls through", async () => {
  const impl = vi.fn((a: number, b: number) => a + b);
  const add = recordTool("add", impl);
  const result = add(1, 2);
  expect(result).toBeInstanceOf(Promise);
  expect(await result).toBe(3);
  expect(impl).toHaveBeenCalledTimes(1);
});

test("Vercel-style second arg with AbortSignal is accepted", async () => {
  const impl = vi.fn(
    async (args: { city: string }, _opts: { toolCallId: string; abortSignal: AbortSignal }) =>
      `sunny in ${args.city}`,
  );
  const weather = recordTool("weather", impl);
  const opts = { toolCallId: "call_1", abortSignal: new AbortController().signal };
  await replay("t4", () => weather({ city: "Oslo" }, opts), { dir });
  expect(await replay("t4", () => weather({ city: "Oslo" }, opts), { dir })).toBe("sunny in Oslo");
  expect(impl).toHaveBeenCalledTimes(1);
});

/** An opaque handle whose state JSON cannot see. */
class Logger {
  readonly #lines: string[] = [];
  /**
   * @param line - Text to log.
   */
  log(line: string): void {
    this.#lines.push(line);
  }
}

test("calls that differ only in a mapped-out arg replay as the same call", async () => {
  const impl = vi.fn(async (q: string, _ctx: { requestId: string }) => q.length);
  const count = recordTool("count", impl, { args: (q) => [q] });
  await replay("t5", () => count("abc", { requestId: "r-1" }), { dir });
  expect(await replay("t5", () => count("abc", { requestId: "r-2" }), { dir })).toBe(3);
  expect(impl).toHaveBeenCalledTimes(1);
});

test("a mapped-out arg never appears in the recording file", async () => {
  const count = recordTool("count", async (q: string, _ctx: { requestId: string }) => q.length, {
    args: (q) => [q],
  });
  await replay("t6", () => count("abc", { requestId: "secret-request-id" }), { dir });
  expect(readFileSync(join(dir, "t6.json"), "utf8")).not.toContain("secret-request-id");
});

test("fn receives the original args when a mapper is given", async () => {
  const logger = new Logger();
  const impl = vi.fn(async (_logger: Logger, q: string) => q);
  const find = recordTool("find", impl, { args: (_l, q) => [q] });
  await replay("t7", () => find(logger, "abc"), { dir });
  expect(impl.mock.calls[0]?.[0]).toBe(logger);
});

test("the mapper is not called outside replay()", async () => {
  const mapper = vi.fn((q: string) => [q]);
  const echo = recordTool("echo", async (q: string) => q, { args: mapper });
  expect(await echo("x")).toBe("x");
  expect(mapper).not.toHaveBeenCalled();
});

test("a rejected raw arg throws ReplayUsageError mentioning { args }", async () => {
  const impl = vi.fn(async (_logger: Logger) => 1);
  const tool = recordTool("withLogger", impl);
  const err = (await replay("t8", () => tool(new Logger()), { dir }).catch(
    (e: unknown) => e,
  )) as Error;
  expect(err).toBeInstanceOf(ReplayUsageError);
  expect(err.message).toContain("{ args }");
  expect(impl).not.toHaveBeenCalled();
});

test("a tool that calls the model is one step and replays without running", async () => {
  const impl = vi.fn(async (text: string) => (await chat(server, text)).body);
  const summarize = recordTool("summarize", impl);
  const first = await replay("t9", () => summarize("hi"), { dir });
  expect(stepsOf("t9").map((s) => s.type)).toEqual(["tool"]);
  const second = await replay("t9", () => summarize("hi"), { dir });
  expect(second).toEqual(first);
  expect(impl).toHaveBeenCalledTimes(1);
  expect(server.hits).toBe(1);
});

test("a wrapped tool called by a wrapped tool is recorded as the outer tool only", async () => {
  const inner = vi.fn(async (q: string) => q.length);
  const lookup = recordTool("lookup", inner);
  const plan = recordTool("plan", async (q: string) => (await lookup(q)) * 2);
  await replay("t10", () => plan("abc"), { dir });
  expect(stepsOf("t10").map((s) => (s.type === "tool" ? s.name : s.type))).toEqual(["plan"]);
  expect(await replay("t10", () => plan("abc"), { dir })).toBe(6);
  expect(inner).toHaveBeenCalledTimes(1);
});

test("in update mode a tool that calls the model is re-recorded as one step", async () => {
  const summarize = recordTool(
    "summarize",
    async (text: string) => (await chat(server, text)).body,
  );
  await replay("t11", () => summarize("a"), { dir });
  vi.stubEnv("AGENT_RETRACE_MODE", "update");
  await replay("t11", () => summarize("b"), { dir });
  const steps = stepsOf("t11");
  expect(steps.map((s) => s.type)).toEqual(["tool"]);
  expect(steps[0]?.type === "tool" && steps[0].args).toEqual(["b"]);
});

test("redaction rules apply to tool args, results and error messages", async () => {
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  const lookup = recordTool("lookup", async (id: string) => ({ id, note: `found ${id}` }));
  const cancel = recordTool("cancel", async (id: string) => {
    throw new Error(`cannot cancel ${id}`);
  });
  await replay(
    "t12",
    async () => {
      await lookup("ORDER-123");
      await cancel("ORDER-123").catch(() => undefined);
    },
    { dir },
  );
  const file = readFileSync(join(dir, "t12.json"), "utf8");
  expect(file).not.toContain("ORDER-123");
  expect(file).toContain("[REDACTED]");
});

test("tool args that differ only in redacted text replay as the same call", async () => {
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  const impl = vi.fn(async (id: string) => id.length);
  const lookup = recordTool("lookup", impl);
  await replay("t13", () => lookup("ORDER-123"), { dir });
  expect(await replay("t13", () => lookup("ORDER-999"), { dir })).toBe(9);
  expect(impl).toHaveBeenCalledTimes(1);
});

test("a provider key from the environment never reaches a tool step", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-env-KEY-0123456789");
  const config = recordTool("config", async (k: string) => ({
    key: process.env.OPENAI_API_KEY,
    k,
  }));
  await replay("t14", () => config("sk-env-KEY-0123456789"), { dir });
  expect(readFileSync(join(dir, "t14.json"), "utf8")).not.toContain("sk-env-KEY-0123456789");
});

/** A tool error with an extra field, as HTTP clients throw. */
class HttpError extends Error {
  readonly status: number;
  /**
   * @param message - What went wrong.
   * @param status - HTTP status code.
   */
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** A tool result whose prototype JSON cannot keep. */
class Order {
  readonly id = "A-1";
  readonly placed = new Date("2026-01-02T03:04:05.000Z");
  /**
   * @returns A label for the order.
   */
  label(): string {
    return `order ${this.id}`;
  }
}

/**
 * Runs a body once to record it and once to replay it.
 *
 * @param name - Recording name.
 * @param fn - The test body.
 * @returns What the body returned on each run.
 */
async function recordThenReplay<T>(name: string, fn: () => Promise<T>): Promise<[T, T]> {
  const live = await replay(name, fn, { dir });
  return [live, await replay(name, fn, { dir })];
}

test("a live tool returns the same JSON copy, in the same key order, that replay returns", async () => {
  // Agents often send `JSON.stringify(result)` back to the model, so a result
  // that differs between recording and replay, even only in key order,
  // changes the next request. `toEqual` ignores key order; the JSON text does not.
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  const impl = vi.fn(async () => ({
    id: "B2",
    status: "shipped",
    "10": "ten",
    "2": "two",
    order: new Order(),
    lines: [{ sku: "W-1", qty: 1, name: "Throw" }],
    note: "found ORDER-123",
    items: [1],
  }));
  const lookup = recordTool("lookup", impl);
  const [live, replayed] = await recordThenReplay("t-result", async () => {
    const result = await lookup();
    const text = JSON.stringify(result);
    // A caller mutating the live result must not change the recording.
    result.items.push(2);
    return { text, isOrder: result.order instanceof Order };
  });
  expect(impl).toHaveBeenCalledTimes(1);
  expect(live.isOrder).toBe(false);
  expect(JSON.parse(live.text)).toEqual({
    id: "B2",
    status: "shipped",
    "10": "ten",
    "2": "two",
    order: { id: "A-1", placed: "2026-01-02T03:04:05.000Z" },
    lines: [{ sku: "W-1", qty: 1, name: "Throw" }],
    note: "found [REDACTED]",
    items: [1],
  });
  expect(replayed).toEqual(live);
});

/**
 * Calls a tool and returns what it threw.
 *
 * @param call - The tool call.
 * @returns The thrown value.
 */
async function thrown(call: () => Promise<unknown>): Promise<Error & Record<string, unknown>> {
  return (await call().then(
    () => expect.fail("the tool did not throw"),
    (e: unknown) => e,
  )) as Error & Record<string, unknown>;
}

/** What a caller can observe of an error, with its own fields in order. */
interface ErrorView {
  readonly className: string;
  readonly name: string;
  readonly message: string;
  readonly fields: [string, unknown][];
  readonly cause?: ErrorView;
}

/**
 * Describes an error the way a caller sees it, so a live error and its replay
 * can be compared field by field and in field order.
 *
 * @param err - The error.
 * @returns Its class, name, message, own fields and cause.
 */
function view(err: Error): ErrorView {
  return {
    className: err.constructor.name,
    name: err.name,
    message: err.message,
    fields: Object.entries(err),
    ...(err.cause instanceof Error ? { cause: view(err.cause) } : {}),
  };
}

test.each<[string, () => never, ErrorView]>([
  [
    "a custom class keeps its name and fields on a plain Error",
    () => {
      throw new HttpError("rate limited", 429);
    },
    {
      className: "Error",
      name: "HttpError",
      message: "rate limited",
      fields: [
        ["name", "HttpError"],
        ["status", 429],
      ],
    },
  ],
  [
    "a built-in class is rebuilt",
    () => {
      throw new TypeError("not a number");
    },
    { className: "TypeError", name: "TypeError", message: "not a number", fields: [] },
  ],
  [
    "a Node error code is kept and fields that are not primitives are left out",
    () => {
      throw Object.assign(new Error("ENOENT: no such file"), {
        code: "ENOENT",
        errno: -2,
        request: { headers: { authorization: "Bearer secret" } },
      });
    },
    {
      className: "Error",
      name: "Error",
      message: "ENOENT: no such file",
      fields: [
        ["code", "ENOENT"],
        ["errno", -2],
      ],
    },
  ],
  [
    "a cause is kept",
    () => {
      throw new Error("payment failed", { cause: new RangeError("card expired") });
    },
    {
      className: "Error",
      name: "Error",
      message: "payment failed",
      fields: [],
      cause: { className: "RangeError", name: "RangeError", message: "card expired", fields: [] },
    },
  ],
  [
    "the message and fields are redacted",
    () => {
      throw Object.assign(new Error("cannot cancel ORDER-123"), { order: "ORDER-123" });
    },
    {
      className: "Error",
      name: "Error",
      message: "cannot cancel [REDACTED]",
      fields: [["order", "[REDACTED]"]],
    },
  ],
  [
    "a thrown non-Error becomes an Error",
    () => {
      throw "plain string";
    },
    { className: "Error", name: "Error", message: "plain string", fields: [] },
  ],
])("a live tool error is the error replay throws: %s", async (_, fail, expected) => {
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  const tool = recordTool("fail", async () => fail());
  const [live, replayed] = await recordThenReplay("t-error", () => thrown(tool));
  expect(view(live)).toEqual(expected);
  expect(view(replayed)).toEqual(view(live));
  expect(readFileSync(join(dir, "t-error.json"), "utf8")).not.toMatch(/secret|ORDER-123/);
});

test("a live tool error keeps the tool's stack", async () => {
  const failingTool = recordTool("boom", async function failingToolBody() {
    throw new Error("boom");
  });
  const err = await replay("t23", () => thrown(failingTool), { dir });
  expect(err.stack).toContain("failingToolBody");
});

test("a key seen in a provider request header is scrubbed from later tool steps, which still replay", async () => {
  // chat() sends "Bearer sk-test-SECRET123"; no key is set in the environment.
  const impl = vi.fn(async (note: string) => `saw ${note}`);
  const echo = recordTool("echo", impl);
  const agent = async (): Promise<string> => {
    await chat(server, "hi");
    return echo("key sk-test-SECRET123");
  };
  // A live call returns what replay will (see "a live tool returns the same JSON copy, in the same key order, that replay returns").
  expect(await replay("t-secret", agent, { dir })).toBe("saw key [REDACTED]");
  const text = readFileSync(join(dir, "t-secret.json"), "utf8");
  expect(text).not.toContain("sk-test-SECRET123");
  expect(stepsOf("t-secret")[1]).toMatchObject({ args: ["key [REDACTED]"] });

  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  expect(await replay("t-secret", agent, { dir })).toBe("saw key [REDACTED]");
  expect(impl).toHaveBeenCalledTimes(1);
});

test("a tool step recorded before the request that reveals the key never stores it", async () => {
  const echo = recordTool("echo", async (note: string) => `saw ${note}`);
  await replay(
    "t-secret-early",
    async () => {
      await echo("key sk-test-SECRET123");
      await chat(server, "hi");
    },
    { dir },
  );
  expect(readFileSync(join(dir, "t-secret-early.json"), "utf8")).not.toContain("sk-test-SECRET123");
});
