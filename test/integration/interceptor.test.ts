/**
 * Integration tests for the dispatcher interceptor, driven with plain `fetch`
 * against local servers that stand in for a provider.
 */
import https from "node:https";
import { gzipSync } from "node:zlib";
import { getGlobalDispatcher, fetch as undiciFetch } from "undici";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { configure, resetConfig } from "../../src/config.js";
import { defaultConfig } from "../../src/defaults.js";
import { ProviderCallBlockedError } from "../../src/errors.js";
import { installHttpGuard, installInterceptor } from "../../src/http/interceptor.js";
import type { LlmStep, Recording } from "../../src/recording/format.js";
import { runtime } from "../../src/runtime.js";
import { Session, type Strategy } from "../../src/session.js";
import { startServer, type TestServer } from "../support/http-server.js";

const servers: TestServer[] = [];

/**
 * Starts a server that is closed after the test.
 *
 * @param handler - Request handler.
 * @returns The server.
 */
async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

/**
 * Creates a session whose saved recordings are collected.
 *
 * @param strategy - The session strategy.
 * @param recording - The existing recording, if any.
 * @returns The session and the list of saved recordings.
 */
function newSession(strategy: Strategy, recording?: Recording) {
  const saved: Recording[] = [];
  const session = new Session({
    name: "demo",
    recordingPath: "/work/__recordings__/demo.json",
    strategy,
    recording,
    command: "AGENT_RETRACE_MODE=update npx vitest run",
    config: defaultConfig(),
    save: async (r) => {
      saved.push(r);
    },
  });
  return { session, saved };
}

/**
 * Sends a JSON POST to a server.
 *
 * @param server - Target server.
 * @param path - Request path.
 * @returns The fetch response.
 */
function post(server: TestServer, path = "/v1/chat/completions"): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test-SECRET123" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}

/**
 * Records one call against a server in a record session.
 *
 * @param server - Target server.
 * @returns The recording that was saved.
 */
async function recordOnce(server: TestServer): Promise<Recording> {
  const { session, saved } = newSession("record");
  await runtime().als.run(session, async () => {
    await (await post(server)).arrayBuffer();
  });
  await session.finish(undefined);
  return saved[0] as Recording;
}

beforeAll(() => {
  installInterceptor();
  installHttpGuard();
});

beforeEach(() => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetConfig();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

test("non-provider traffic passes through in replay mode", async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const other = await serve((_req, res) => res.end("hello"));
  const res = await fetch(`${other.url}/anything`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello");
});

test("provider call outside replay() is blocked in replay mode", async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const provider = await serve((_req, res) => res.end("{}"));
  configure({ providerHosts: [provider.host] });
  const res = await fetch(`${provider.url}/v1/chat/completions`, { method: "POST", body: "{}" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
    /outside replay/,
  );
  expect(provider.hits).toBe(0);
});

test("provider call outside replay() passes through in auto mode", async () => {
  const provider = await serve((_req, res) => res.end('{"live":true}'));
  configure({ providerHosts: [provider.host] });
  const res = await fetch(`${provider.url}/v1/x`, { method: "POST", body: "{}" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ live: true });
  expect(provider.hits).toBe(1);
});

test("record then replay via session, streamed SSE arrives in chunks", async () => {
  const provider = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      n++;
      res.write(`data: {"n":${n}}\n\n`);
      if (n === 3) {
        clearInterval(timer);
        res.end("data: [DONE]\n\n");
      }
    }, 10);
  });
  configure({ providerHosts: [provider.host] });

  const recording = await recordOnce(provider);
  const step = recording.steps[0] as LlmStep;
  expect(provider.hits).toBe(1);
  expect(step.response.events).toEqual([
    { data: { n: 1 } },
    { data: { n: 2 } },
    { data: { n: 3 } },
    { text: "[DONE]" },
  ]);
  expect(JSON.stringify(recording)).not.toContain("SECRET123");

  const { session } = newSession("strict", recording);
  const chunks = await runtime().als.run(session, async () => {
    const res = await post(provider);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const seen: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(Buffer.from(value).toString());
    }
    return seen;
  });
  await session.finish(undefined);
  expect(provider.hits).toBe(1);
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  expect(chunks.join("")).toBe(
    'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\ndata: [DONE]\n\n',
  );
});

test("gzip from server stored decoded", async () => {
  const provider = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipSync('{"ok":true}'));
  });
  configure({ providerHosts: [provider.host] });
  const recording = await recordOnce(provider);
  const step = recording.steps[0] as LlmStep;
  expect(step.response.body).toEqual({ ok: true });
  expect(step.response.headers).toEqual({ "content-type": "application/json" });

  // Replay serves it without content-encoding, so fetch must not try to decompress.
  const { session } = newSession("strict", recording);
  const body = await runtime().als.run(session, async () => (await post(provider)).json());
  expect(body).toEqual({ ok: true });
});

test("transient responses are not recorded", async () => {
  const provider = await serve((_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end('{"error":"slow down"}');
  });
  configure({ providerHosts: [provider.host] });
  const recording = await recordOnce(provider);
  expect(recording.steps).toEqual([]);
});

test("a connection failure is not recorded and reaches the caller", async () => {
  const provider = await serve((_req, res) => res.end("{}"));
  configure({ providerHosts: [provider.host] });
  await provider.close();
  const { session, saved } = newSession("record");
  await runtime().als.run(session, async () => {
    await expect(post(provider)).rejects.toThrow();
  });
  await session.finish(undefined);
  expect((saved[0] as Recording).steps).toEqual([]);
});

test("a changed request is answered with the change report as a 400", async () => {
  const provider = await serve((_req, res) => res.end('{"ok":true}'));
  configure({ providerHosts: [provider.host] });
  const recording = await recordOnce(provider);
  const { session } = newSession("strict", recording);
  const hitsBefore = provider.hits;
  const res = await runtime().als.run(session, () =>
    fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "different" }] }),
    }),
  );
  expect(res.status).toBe(400);
  const { error } = (await res.json()) as { error: { type: string; message: string } };
  expect(error.type).toBe("agent_retrace_error");
  expect(error.message).toMatch(/changed at step 1 of 1/);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: checks that no ANSI escape survives
  expect(error.message).not.toMatch(/\u001b\[/);
  expect(provider.hits).toBe(hitsBefore);
  await expect(session.finish(undefined)).rejects.toThrow(/changed at step 1 of 1/);
});

test("a provider call after replay() finished is answered with a 400", async () => {
  const provider = await serve((_req, res) => res.end("{}"));
  configure({ providerHosts: [provider.host] });
  const { session } = newSession("record");
  await session.finish(undefined);
  const res = await runtime().als.run(session, () => post(provider));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
    /after its replay\(\) call had finished/,
  );
  expect(provider.hits).toBe(0);
});

test("abort during replay rejects with AbortError", async () => {
  const provider = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n");
  });
  configure({ providerHosts: [provider.host] });
  const recording = await recordOnce(provider);
  const { session } = newSession("strict", recording);
  await runtime().als.run(session, async () => {
    const controller = new AbortController();
    const res = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    });
    controller.abort();
    await expect(res.text()).rejects.toMatchObject({ name: "AbortError" });
  });
});

/**
 * Sends a streaming request and aborts it once the first event has arrived,
 * the way an SDK does when the agent breaks out of a stream early.
 *
 * @param server - Target server.
 * @returns The text received before the abort.
 */
async function readFirstEventThenAbort(server: TestServer): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true }),
    signal: controller.signal,
  });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let seen = "";
  while (!seen.includes("\n\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += Buffer.from(value).toString();
  }
  controller.abort();
  await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  return seen;
}

test("a stream the consumer aborts is recorded up to the abort and replays", async () => {
  const provider = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // The rest of the stream never comes; the client stops reading first.
    res.write('data: {"n":1}\n\n');
  });
  configure({ providerHosts: [provider.host] });

  const { session, saved } = newSession("record");
  await runtime().als.run(session, () => readFirstEventThenAbort(provider));
  await session.finish(undefined);
  const recording = saved[0] as Recording;
  expect(recording.steps).toHaveLength(1);
  expect((recording.steps[0] as LlmStep).response.events).toEqual([{ data: { n: 1 } }]);

  const replay = newSession("strict", recording);
  const seen = await runtime().als.run(replay.session, () => readFirstEventThenAbort(provider));
  await replay.session.finish(undefined);
  expect(seen).toBe('data: {"n":1}\n\n');
  expect(provider.hits).toBe(1);
});

test("concurrent requests are recorded in the order they were issued", async () => {
  const provider = await serve((_req, res, body) => res.end(body));
  configure({ providerHosts: [provider.host] });
  const { session, saved } = newSession("record");
  await runtime().als.run(session, async () => {
    // A's body takes longer to read than B's, so B is ready first.
    const slowBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.enqueue(new TextEncoder().encode('"A"}'));
        controller.close();
      },
    });
    const a = fetch(`${provider.url}/v1/x`, {
      method: "POST",
      body: slowBody,
      duplex: "half",
    } as RequestInit);
    const b = fetch(`${provider.url}/v1/x`, { method: "POST", body: '{"id":"B"}' });
    await Promise.all([(await a).arrayBuffer(), (await b).arrayBuffer()]);
  });
  await session.finish(undefined);
  const ids = (saved[0] as Recording).steps.map(
    (step) => ((step as LlmStep).request.body as { id: string }).id,
  );
  expect(ids).toEqual(["A", "B"]);
});

test("requests made with the dispatcher's request() method are intercepted", async () => {
  const provider = await serve((_req, res) => res.end('{"ok":true}'));
  configure({ providerHosts: [provider.host] });
  const { session, saved } = newSession("record");
  await runtime().als.run(session, async () => {
    const res = await getGlobalDispatcher().request({
      origin: provider.url,
      path: "/v1/x",
      method: "POST",
      body: "{}",
    });
    expect(await res.body.json()).toEqual({ ok: true });
  });
  await session.finish(undefined);
  expect((saved[0] as Recording).steps).toHaveLength(1);
});

test("requests made with undici's own fetch are intercepted too", async () => {
  const provider = await serve((_req, res) => res.end('{"ok":true}'));
  configure({ providerHosts: [provider.host] });
  const { session, saved } = newSession("record");
  await runtime().als.run(session, async () => {
    const res = await undiciFetch(`${provider.url}/v1/x`, { method: "POST", body: "{}" });
    expect(await res.json()).toEqual({ ok: true });
  });
  await session.finish(undefined);
  expect((saved[0] as Recording).steps).toHaveLength(1);
});

test("a body sent as a stream is captured", async () => {
  const provider = await serve((_req, res) => res.end("{}"));
  configure({ providerHosts: [provider.host] });
  const { session, saved } = newSession("record");
  await runtime().als.run(session, async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        controller.enqueue(new TextEncoder().encode("1}"));
        controller.close();
      },
    });
    await (
      await fetch(`${provider.url}/v1/x`, { method: "POST", body, duplex: "half" } as RequestInit)
    ).arrayBuffer();
  });
  await session.finish(undefined);
  expect(((saved[0] as Recording).steps[0] as LlmStep).request.body).toEqual({ a: 1 });
});

test("node:https to provider host throws in replay mode", () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  expect(() => https.request("https://api.openai.com/v1/models")).toThrow(ProviderCallBlockedError);
});

test("node:https to provider host throws inside a session even in auto mode", async () => {
  const { session } = newSession("record");
  runtime().als.run(session, () => {
    expect(() => https.get("https://api.openai.com/v1/models")).toThrow(/use fetch or undici/);
  });
  await session.finish(undefined);
});

test("node:http to other hosts is untouched", async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const other = await serve((_req, res) => res.end("plain"));
  const http = await import("node:http");
  const body = await new Promise<string>((resolve, reject) => {
    http
      .get(`${other.url}/x`, (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
  expect(body).toBe("plain");
});

test("installInterceptor is idempotent", async () => {
  installInterceptor();
  installInterceptor();
  const provider = await serve((_req, res) => res.end('{"ok":true}'));
  configure({ providerHosts: [provider.host] });
  const recording = await recordOnce(provider);
  // Wrapped twice, the call would be captured and committed twice and `commit` would throw.
  expect(recording.steps).toHaveLength(1);
  expect(provider.hits).toBe(1);
});

test("installInterceptor re-wraps a dispatcher that someone else replaced", async () => {
  const key = Symbol.for("undici.globalDispatcher.1");
  const g = globalThis as Record<symbol, object>;
  const ours = g[key] as object;
  // A foreign dispatcher that forwards to ours stands in for msw, nock or a ProxyAgent.
  const foreign = new Proxy(ours, {});
  g[key] = foreign;
  try {
    installInterceptor();
    expect(g[key]).not.toBe(foreign);
    const provider = await serve((_req, res) => res.end("{}"));
    configure({ providerHosts: [provider.host] });
    vi.stubEnv("AGENT_RETRACE_MODE", "replay");
    const res = await post(provider);
    expect(res.status).toBe(400);
    expect(provider.hits).toBe(0);
    // The old wrapper is still underneath: a request must still be captured once.
    const recording = await recordOnce(provider);
    expect(recording.steps).toHaveLength(1);
  } finally {
    g[key] = ours;
  }
});
