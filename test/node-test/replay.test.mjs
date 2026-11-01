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
 * connector sends live requests for that host, and only that host, to the
 * local server instead.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChangeDetectedError, configure, recordTool, replay } from "agent-retrace";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const PROVIDER_HOST = "llm.node-test.invalid";
const ORIGIN = `http://${PROVIDER_HOST}`;
const THIS_FILE = fileURLToPath(import.meta.url);
const RECORDINGS = join(dirname(THIS_FILE), "__recordings__");

/** Number of requests the local provider has received. */
let hits = 0;
/** @type {import("node:http").Server} */
let server;
/** @type {Agent} */
let agent;
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
 * Request handler of the local provider: echoes the first user message back.
 * A body that is not JSON gets a 400, so a bad request fails the test that
 * sent it instead of crashing the test process.
 *
 * @param {import("node:http").IncomingMessage} req - The request.
 * @param {import("node:http").ServerResponse} res - The response.
 */
function echoProvider(req, res) {
  hits++;
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      res.statusCode = 400;
      res.end("request body is not JSON");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ echo: body.messages?.[0]?.content ?? null }));
  });
}

/**
 * Builds an undici connector that opens a TCP connection to the local
 * provider for `http://llm.node-test.invalid` and refuses any other origin,
 * so a stray request fails loudly instead of reaching the echo server.
 *
 * @param {number} port - Port of the local provider on 127.0.0.1.
 * @returns {import("undici").buildConnector.connector} The connector.
 */
function localConnector(port) {
  return (opts, callback) => {
    if (opts.hostname !== PROVIDER_HOST || opts.protocol !== "http:") {
      callback(new Error(`node-test: unexpected request to ${opts.protocol}//${opts.host}`), null);
      return;
    }
    const socket = connect(port, "127.0.0.1");
    // Settles once: after the socket is handed over, undici owns its errors.
    const onError = (err) => callback(err, null);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      callback(null, socket);
    });
  };
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
  /**
   * Runs the agent.
   *
   * @returns {Promise<unknown[]>} The response bodies, in order.
   */
  return async () => {
    const out = [];
    for (const content of contents) out.push(await chat(content));
    return out;
  };
}

before(async () => {
  server = createServer(echoProvider);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  previousDispatcher = getGlobalDispatcher();
  agent = new Agent({ connect: localConnector(port) });
  // Installed after agent-retrace's own interceptor; `replay()` re-installs
  // on top of whatever dispatcher is global when it starts.
  setGlobalDispatcher(agent);
  configure({ providerHosts: [PROVIDER_HOST] });
});

after(async () => {
  // Default provider hosts always stay, so an empty list undoes `before`.
  configure({ providerHosts: [] });
  setGlobalDispatcher(previousDispatcher);
  await agent.close();
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
  /**
   * Calls the wrapped tool, then the provider twice.
   *
   * @returns {Promise<unknown[]>} The tool result followed by the response bodies.
   */
  const toolThenChats = async () => [await lookup("A-1"), ...(await agentFor(["one", "two"])())];

  setMode("auto");
  const start = hits;
  const first = await replay("record-then-replay", toolThenChats, { dir });
  assert.equal(hits - start, 2);
  assert.equal(toolRuns, 1);
  assert.deepEqual(first, [{ id: "A-1", status: "shipped" }, { echo: "one" }, { echo: "two" }]);
  assert.ok(existsSync(join(dir, "record-then-replay.json")));

  setMode("replay");
  const second = await replay("record-then-replay", toolThenChats, { dir });
  assert.equal(hits - start, 2);
  assert.equal(toolRuns, 1);
  assert.deepEqual(second, first);
});

test("records into __recordings__ next to this test file by default", async () => {
  const file = join(RECORDINGS, "node-test-default-dir.json");
  await rm(file, { force: true });
  try {
    setMode("auto");
    const start = hits;
    await replay("node-test-default-dir", agentFor(["where"]));
    assert.equal(hits - start, 1);
    assert.ok(existsSync(file), `expected a recording at ${file}`);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "node-test-default-dir");
  } finally {
    await rm(file, { force: true });
  }
});

test("replays the committed recording from the default __recordings__ dir", async () => {
  // Runs in the ambient mode: replays in CI and in local auto mode, and
  // rewrites the recording under AGENT_RETRACE_MODE=update.
  const start = hits;
  const result = await replay("node-test-basic", agentFor(["hello"]));
  assert.deepEqual(result, [{ echo: "hello" }]);
  if (process.env.AGENT_RETRACE_MODE !== "update") assert.equal(hits, start);
});

test("a changed request rejects with the node --test re-record command", async () => {
  setMode("auto");
  await replay("changed", agentFor(["a"]), { dir });
  const start = hits;
  // The command names this file relative to where node --test was started.
  const file = relative(process.cwd(), THIS_FILE).split(sep).join("/");
  await assert.rejects(replay("changed", agentFor(["b"]), { dir }), (err) => {
    assert.ok(err instanceof ChangeDetectedError, `expected ChangeDetectedError, got ${err}`);
    assert.match(err.message, /changed at step 1 of 1/);
    assert.ok(err.message.includes(`AGENT_RETRACE_MODE=update node --test ${file}`), err.message);
    return true;
  });
  assert.equal(hits, start);
});
