/**
 * Two copies of agent-retrace in one process (Review Focus 1): the
 * interceptor installed by the first copy must find sessions started by the
 * second.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetConfig } from "../../src/config.js";
import type { Recording } from "../../src/index.js";
import * as copyA from "../../src/index.js";
import { calls, echoHandler } from "../support/agent.js";
import { startServer, type TestServer } from "../support/http-server.js";

let server: TestServer;
let dir: string;

beforeEach(async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
  server = await startServer(echoHandler);
  copyA.configure({ providerHosts: [server.host] });
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-dup-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetConfig();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("a second copy's replay() is recorded through the first copy's interceptor", async () => {
  // Clearing Vitest's module cache makes the next import evaluate every
  // module of the library again, like a package installed twice.
  const dispatcher = getGlobalDispatcher();
  vi.resetModules();
  const copyB: typeof copyA = await import("../../src/index.js");
  // Copy B saw copy A's wrapper and left it in place, so copy A's
  // interceptor is the one that handles copy B's requests.
  expect(getGlobalDispatcher()).toBe(dispatcher);
  expect(copyB).not.toBe(copyA);
  expect(copyB.replay).not.toBe(copyA.replay);

  await copyB.replay("dup", calls(server, ["a"]), { dir });
  const recording = JSON.parse(readFileSync(join(dir, "dup.json"), "utf8")) as Recording;
  expect(recording.steps).toHaveLength(1);
  expect(server.hits).toBe(1);

  await copyB.replay("dup", calls(server, ["a"]), { dir });
  expect(server.hits).toBe(1);
});
