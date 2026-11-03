/**
 * Tiny stand-in agents for integration tests: functions that call a local
 * provider server with plain `fetch`, one request per user message.
 */
import type { TestServer } from "./http-server.js";

/**
 * Sends one chat request with a single user message and reads the response.
 *
 * @param server - The provider server.
 * @param content - The user message.
 * @returns The HTTP status and the parsed JSON body.
 */
export async function chat(
  server: TestServer,
  content: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test-SECRET123" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] }),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Builds an agent that sends one request per message, in order.
 *
 * @param server - The provider server.
 * @param contents - The user messages.
 * @returns An async function returning the response bodies.
 */
export function calls(server: TestServer, contents: string[]): () => Promise<unknown[]> {
  return async () => {
    const out: unknown[] = [];
    for (const content of contents) out.push((await chat(server, content)).body);
    return out;
  };
}

/**
 * Request handler for a provider server that echoes the user message back.
 *
 * @param _req - The request.
 * @param res - The response.
 * @param body - The request body bytes.
 */
export function echoHandler(
  _req: unknown,
  res: { setHeader(k: string, v: string): void; end(s: string): void },
  body: Buffer,
): void {
  const parsed = JSON.parse(body.toString() || "{}") as {
    messages?: { content?: string }[];
  };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ echo: parsed.messages?.[0]?.content ?? null }));
}
