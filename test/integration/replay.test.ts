/**
 * Integration tests for `replay()`, driven with plain `fetch` against a local
 * server configured as a provider host.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetConfig } from "../../src/config.js";
import {
  ChangeDetectedError,
  configure,
  type Recording,
  RecordingNotFoundError,
  ReplayUsageError,
  replay,
} from "../../src/index.js";
import { calls, chat, echoHandler } from "../support/agent.js";
import { startServer, type TestServer } from "../support/http-server.js";

let server: TestServer;
let dir: string;

beforeEach(async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
  server = await startServer(echoHandler);
  configure({ providerHosts: [server.host] });
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-replay-"));
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

test("auto records on first run, replays on second without network", async () => {
  const agent = calls(server, ["one", "two"]);
  const first = await replay("r1", agent, { dir });
  expect(server.hits).toBe(2);
  expect(existsSync(join(dir, "r1.json"))).toBe(true);
  const second = await replay("r1", agent, { dir });
  expect(server.hits).toBe(2);
  expect(second).toEqual(first);
  expect(first).toEqual([{ echo: "one" }, { echo: "two" }]);
});

test("replay returns the function's value, sync or async", async () => {
  expect(await replay("sync", () => 42, { dir })).toBe(42);
  expect(await replay("async", async () => "x", { dir })).toBe("x");
});

test("replay mode without recording fails before any network", async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const err = await replay("missing", calls(server, ["a"]), { dir }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RecordingNotFoundError);
  expect((err as Error).message).toContain("without CI set");
  expect((err as Error).message).toContain("commit the __recordings__ folder");
  expect((err as Error).message).not.toContain("AGENT_RETRACE_MODE");
  expect((err as Error).message).toContain("npx vitest run test/integration/replay.test.ts");
  expect(server.hits).toBe(0);
});

test("auto mode never re-records on change", async () => {
  await replay("r6", calls(server, ["a"]), { dir });
  const before = readFileSync(join(dir, "r6.json"));
  await expect(replay("r6", calls(server, ["b"]), { dir })).rejects.toBeInstanceOf(
    ChangeDetectedError,
  );
  expect(readFileSync(join(dir, "r6.json"))).toEqual(before);
  expect(server.hits).toBe(1);
});

test("swallowed SDK error still fails the test", async () => {
  await replay("r2", calls(server, ["a"]), { dir });
  await expect(
    replay(
      "r2",
      async () => {
        try {
          const res = await chat(server, "b");
          if (res.status !== 200) throw new Error("provider error");
        } catch {}
        return "fallback";
      },
      { dir },
    ),
  ).rejects.toBeInstanceOf(ChangeDetectedError);
});

test("the function's own error is rethrown when nothing changed", async () => {
  await expect(
    replay(
      "boom",
      async () => {
        await chat(server, "a");
        throw new Error("agent failed");
      },
      { dir },
    ),
  ).rejects.toThrow("agent failed");
});

test("update mode rewrites only from the change and counts live calls", async () => {
  await replay("r3", calls(server, ["a", "b", "c"]), { dir });
  const before = server.hits;
  vi.stubEnv("AGENT_RETRACE_MODE", "update");
  await replay("r3", calls(server, ["a", "B", "c"]), { dir });
  expect(server.hits - before).toBe(2);
  const contents = stepsOf("r3").map((s) =>
    s.type === "llm"
      ? (s.request.body as { messages: { content: string }[] }).messages[0]?.content
      : undefined,
  );
  expect(contents).toEqual(["a", "B", "c"]);
});

test("concurrent replays do not mix", async () => {
  await Promise.all([
    replay("c1", calls(server, ["x"]), { dir }),
    replay("c2", calls(server, ["y", "z"]), { dir }),
  ]);
  expect(stepsOf("c1")).toHaveLength(1);
  expect(stepsOf("c2")).toHaveLength(2);
});

test("nested replay throws", async () => {
  await expect(replay("outer", () => replay("inner", () => 1, { dir }), { dir })).rejects.toThrow(
    ReplayUsageError,
  );
  await expect(replay("outer", () => replay("inner", () => 1, { dir }), { dir })).rejects.toThrow(
    /cannot be nested/,
  );
});

test("same recording concurrently throws", async () => {
  const results = await Promise.allSettled([
    replay("same", calls(server, ["a"]), { dir }),
    replay("same", calls(server, ["a"]), { dir }),
  ]);
  expect(results[0]?.status).toBe("fulfilled");
  expect(results[1]?.status).toBe("rejected");
  expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ReplayUsageError);
  // The path is released afterwards, so a later run can use it.
  await replay("same", calls(server, ["a"]), { dir });
});

test("invalid recording name is rejected", async () => {
  await expect(replay("../escape", () => 1, { dir })).rejects.toThrow(/Invalid recording name/);
});

test("default dir is __recordings__ next to the test file", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const expected = join(here, "__recordings__", "default-dir-check.json");
  try {
    await replay("default-dir-check", calls(server, ["a"]));
    expect(existsSync(expected)).toBe(true);
  } finally {
    await rm(join(here, "__recordings__"), { recursive: true, force: true });
  }
});

test("re-installs when another library replaced the global dispatcher", async () => {
  await replay("r4", calls(server, ["a"]), { dir });
  const sym = Symbol.for("undici.globalDispatcher.1");
  (globalThis as Record<symbol, unknown>)[sym] = new Agent();
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const before = server.hits;
  await replay("r4", calls(server, ["a"]), { dir });
  expect(server.hits).toBe(before);
});

test("redaction rule applies to recording and to matching", async () => {
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  await replay("r5", calls(server, ["refund ORDER-123"]), { dir });
  expect(readFileSync(join(dir, "r5.json"), "utf8")).not.toContain("ORDER-123");
  await replay("r5", calls(server, ["refund ORDER-999"]), { dir });
  expect(server.hits).toBe(1);
});
