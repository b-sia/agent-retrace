/**
 * Runs agent-retrace under the `node:test` runner against the built package,
 * the way a user without Vitest would: `import ... from "agent-retrace"`
 * resolves through this package's own `exports` (a package may import itself
 * by name) to `dist/`, so `npm run test:node` builds first.
 *
 * The provider is a local `http.createServer`, reached through a fixed origin
 * (`http://llm.node-test.invalid`) so that a committed recording keeps
 * matching across runs: the URL is part of the match key, and the server's
 * port changes every run. The `.invalid` name never resolves; a custom undici
 * connector sends live requests to the local server instead.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChangeDetectedError, configure, recordTool, replay } from "agent-retrace";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const ORIGIN = "http://llm.node-test.invalid";
const HERE = dirname(fileURLToPath(import.meta.url));

/** Number of requests the local provider has received. */
let hits = 0;
/** @type {import("node:http").Server} */
let server;
/** @type {import("undici").Dispatcher} */
let previousDispatcher;
/** @type {string} */
let dir;
/** Value of `AGENT_RETRACE_MODE` when the file started, restored after each test. */
const ambientMode = process.env.AGENT_RETRACE_MODE;

/**
 * Sets or clears `AGENT_RETRACE_MODE` for this process.
 *
 * @param {string | undefined} mode - The mode, or undefined to unset it.
 */
function setMode(mode) {
  if (mode === undefined) delete process.env.AGENT_RETRACE_MODE;
  else process.env.AGENT_RETRACE_MODE = mode;
}

/**
 * Sends one chat request to the provider and reads the JSON answer.
 *
 * @param {string} content - The user message.
 * @returns {Promise<unknown>} The parsed response body.
 * @throws {Error} When the provider answers with a non-2xx status.
 */
async function chat(content) {
  const res = await fetch(`${ORIGIN}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`provider answered ${res.status}`);
  return res.json();
}

/**
 * Builds an agent that sends one chat request per message, in order.
 *
 * @param {string[]} contents - The user messages.
 * @returns {() => Promise<unknown[]>} The agent.
 */
function agentFor(contents) {
  return async () => {
    const out = [];
    for (const content of contents) out.push(await chat(content));
    return out;
  };
}

before(async () => {
  server = createServer((req, res) => {
    hits++;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ echo: body.messages?.[0]?.content ?? null }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  previousDispatcher = getGlobalDispatcher();
  // Installed after agent-retrace's own interceptor; `replay()` re-installs
  // on top of whatever dispatcher is global when it starts.
  setGlobalDispatcher(
    new Agent({
      connect: (_opts, callback) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => callback(null, socket));
        socket.once("error", (err) => callback(err, null));
      },
    }),
  );
  configure({ providerHosts: ["llm.node-test.invalid"] });
});

after(async () => {
  setGlobalDispatcher(previousDispatcher);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-node-test-"));
});

afterEach(async () => {
  setMode(ambientMode);
  await rm(dir, { recursive: true, force: true });
});

test("records in auto mode, then replays in replay mode without the network", async () => {
  let toolRuns = 0;
  const lookup = recordTool("lookup", async (id) => {
    toolRuns++;
    return { id, status: "shipped" };
  });
  const agent = async () => [await lookup("A-1"), ...(await agentFor(["one", "two"])())];

  setMode("auto");
  const start = hits;
  const first = await replay("record-then-replay", agent, { dir });
  assert.equal(hits - start, 2);
  assert.equal(toolRuns, 1);
  assert.deepEqual(first, [{ id: "A-1", status: "shipped" }, { echo: "one" }, { echo: "two" }]);
  assert.ok(existsSync(join(dir, "record-then-replay.json")));

  setMode("replay");
  const second = await replay("record-then-replay", agent, { dir });
  assert.equal(hits - start, 2);
  assert.equal(toolRuns, 1);
  assert.deepEqual(second, first);
});

test("the default __recordings__ dir is next to this test file", async () => {
  // Runs in the ambient mode: replays the committed recording (in CI, and
  // locally in auto mode), and rewrites it under AGENT_RETRACE_MODE=update.
  const start = hits;
  const result = await replay("node-test-basic", agentFor(["hello"]));
  assert.deepEqual(result, [{ echo: "hello" }]);
  if (process.env.AGENT_RETRACE_MODE !== "update") assert.equal(hits, start);
  const file = join(HERE, "__recordings__", "node-test-basic.json");
  assert.ok(existsSync(file), `expected a recording at ${file}`);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "node-test-basic");
});

test("a changed request rejects with the node --test re-record command", async () => {
  setMode("auto");
  await replay("changed", agentFor(["a"]), { dir });
  const start = hits;
  await assert.rejects(replay("changed", agentFor(["b"]), { dir }), (err) => {
    assert.ok(err instanceof ChangeDetectedError, `expected ChangeDetectedError, got ${err}`);
    assert.match(err.message, /changed at step 1 of 1/);
    assert.ok(
      err.message.includes("AGENT_RETRACE_MODE=update node --test test/node-test/replay.test.mjs"),
      err.message,
    );
    return true;
  });
  assert.equal(hits, start);
});
