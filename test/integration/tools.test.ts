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

test("a live tool returns the same JSON copy that replay returns", async () => {
  const impl = vi.fn(async () => new Order());
  const getOrder = recordTool("getOrder", impl);
  const [live, replayed] = await recordThenReplay("t15", () => getOrder());
  expect(impl).toHaveBeenCalledTimes(1);
  expect(live).not.toBeInstanceOf(Order);
  expect(live).toEqual({ id: "A-1", placed: "2026-01-02T03:04:05.000Z" });
  expect(replayed).toEqual(live);
});

test("a live tool returns the redacted value that replay returns", async () => {
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  const lookup = recordTool("lookup", async () => ({ note: "found ORDER-123" }));
  const [live, replayed] = await recordThenReplay("t16", () => lookup());
  expect(live).toEqual({ note: "found [REDACTED]" });
  expect(replayed).toEqual(live);
});

test("a caller mutating a live result cannot change the recording", async () => {
  const list = recordTool("list", async () => ({ items: [1] }));
  await replay(
    "t17",
    async () => {
      (await list()).items.push(2);
    },
    { dir },
  );
  expect(await replay("t17", () => list(), { dir })).toEqual({ items: [1] });
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

test("a live tool error has the same class, name, message and fields as on replay", async () => {
  const fetchPage = recordTool("fetchPage", async () => {
    throw new HttpError("rate limited", 429);
  });
  const [live, replayed] = await recordThenReplay("t18", () => thrown(fetchPage));
  for (const err of [live, replayed]) {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HttpError);
    expect(err.name).toBe("HttpError");
    expect(err.message).toBe("rate limited");
    expect(err.status).toBe(429);
  }
});

test("a built-in error class is rebuilt on replay", async () => {
  const parse = recordTool("parse", async () => {
    throw new TypeError("not a number");
  });
  const [live, replayed] = await recordThenReplay("t19", () => thrown(parse));
  expect(live).toBeInstanceOf(TypeError);
  expect(replayed).toBeInstanceOf(TypeError);
});

test("a Node error code replays, and fields that are not primitives are left out", async () => {
  const read = recordTool("read", async () => {
    throw Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
      errno: -2,
      request: { headers: { authorization: "Bearer secret" } },
    });
  });
  const [live, replayed] = await recordThenReplay("t20", () => thrown(read));
  for (const err of [live, replayed]) {
    expect(err.code).toBe("ENOENT");
    expect(err.errno).toBe(-2);
    expect(err.request).toBeUndefined();
  }
  expect(readFileSync(join(dir, "t20.json"), "utf8")).not.toContain("secret");
});

test("an error cause replays", async () => {
  const charge = recordTool("charge", async () => {
    throw new Error("payment failed", { cause: new RangeError("card expired") });
  });
  const [live, replayed] = await recordThenReplay("t21", () => thrown(charge));
  for (const err of [live, replayed]) {
    expect(err.cause).toBeInstanceOf(RangeError);
    expect((err.cause as Error).message).toBe("card expired");
  }
});

test("a live tool error message and fields are redacted as on replay", async () => {
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  const cancel = recordTool("cancel", async () => {
    throw Object.assign(new Error("cannot cancel ORDER-123"), { order: "ORDER-123" });
  });
  const [live, replayed] = await recordThenReplay("t22", () => thrown(cancel));
  for (const err of [live, replayed]) {
    expect(err.message).toBe("cannot cancel [REDACTED]");
    expect(err.order).toBe("[REDACTED]");
  }
});

test("a live tool error keeps the tool's stack", async () => {
  const failingTool = recordTool("boom", async function failingToolBody() {
    throw new Error("boom");
  });
  const err = await replay("t23", () => thrown(failingTool), { dir });
  expect(err.stack).toContain("failingToolBody");
});

test("a live tool that throws a non-Error throws the Error that replay throws", async () => {
  const legacy = recordTool("legacy", async () => {
    throw "plain string";
  });
  const [live, replayed] = await recordThenReplay("t24", () => thrown(legacy));
  for (const err of [live, replayed]) {
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("plain string");
  }
});
