/**
 * Tests for turning raw HTTP traffic into recorded requests and responses.
 */
import { createHash } from "node:crypto";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { defaultConfig } from "../../src/defaults.js";
import {
  captureRequest,
  captureResponse,
  encodeResponse,
  errorResponse,
  isTransientStatus,
} from "../../src/http/capture.js";

const config = defaultConfig();

test("captureRequest strips auth and scrubs key echoes", () => {
  const { request } = captureRequest(
    {
      method: "POST",
      origin: "https://api.openai.com",
      path: "/v1/chat/completions",
      headers: {
        Authorization: "Bearer sk-test-SECRET123",
        "OpenAI-Beta": "x",
        "x-stainless-os": "Linux",
      },
      body: Buffer.from(
        JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "my key is sk-test-SECRET123" }],
        }),
      ),
    },
    config,
  );
  expect(request.headers).toEqual({ "openai-beta": "x" });
  expect(JSON.stringify(request)).not.toContain("sk-test-SECRET123");
});

test("captureRequest scrubs provider keys from the environment", () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-env-ENVSECRET99");
  try {
    const { request, secrets } = captureRequest(
      {
        method: "POST",
        origin: "https://api.openai.com",
        path: "/v1/x",
        headers: {},
        body: Buffer.from(JSON.stringify({ note: "sk-env-ENVSECRET99" })),
      },
      config,
    );
    expect(secrets).toContain("sk-env-ENVSECRET99");
    expect(JSON.stringify(request)).not.toContain("ENVSECRET99");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("captureRequest keeps a non-JSON body as text and a missing body as neither", () => {
  const base = { method: "POST", origin: "https://api.openai.com", path: "/p", headers: {} };
  expect(captureRequest({ ...base, body: Buffer.from("plain") }, config).request).toEqual({
    method: "POST",
    url: "https://api.openai.com/p",
    headers: {},
    text: "plain",
  });
  expect(captureRequest({ ...base, body: undefined }, config).request).toEqual({
    method: "POST",
    url: "https://api.openai.com/p",
    headers: {},
  });
});

/**
 * Captures a request with the given body and content type.
 *
 * @param body - The raw body.
 * @param contentType - The `content-type` header, if any.
 * @returns The stored text of the request.
 */
function capturedText(body: Buffer, contentType?: string): string | undefined {
  const headers: Record<string, string> = contentType ? { "Content-Type": contentType } : {};
  const { request } = captureRequest(
    { method: "POST", origin: "https://api.openai.com", path: "/v1/files", headers, body },
    config,
  );
  return request.text;
}

/**
 * Builds a multipart body with one text part and one binary part.
 *
 * @param boundary - The boundary to use.
 * @returns The body.
 */
function multipart(boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n`),
    Buffer.from("fine-tune\r\n"),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    ),
    Buffer.from([0xff, 0x00, 0xfe]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

test("captureRequest stores a multipart body the same whatever its boundary", () => {
  const a = capturedText(multipart("AaB03x"), "multipart/form-data; boundary=AaB03x");
  const b = capturedText(multipart("zz-99"), 'multipart/form-data; boundary="zz-99"');
  expect(a).toBe(b);
  expect(a).toBe(
    [
      "--agent-retrace-boundary",
      'Content-Disposition: form-data; name="purpose"',
      "",
      "fine-tune",
      "--agent-retrace-boundary",
      'Content-Disposition: form-data; name="file"; filename="a.bin"',
      "Content-Type: application/octet-stream",
      "",
      `[3 bytes, sha256 ${createHash("sha256")
        .update(Buffer.from([0xff, 0x00, 0xfe]))
        .digest("hex")}]`,
      "--agent-retrace-boundary--",
      "",
    ].join("\r\n"),
  );
});

test("captureRequest stores a binary body that is not multipart by its size and hash", () => {
  const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  expect(capturedText(bytes, "audio/wav")).toBe(`[3 bytes, sha256 ${hash}]`);
});

test("captureRequest applies user redact rules", () => {
  const { request } = captureRequest(
    {
      method: "POST",
      origin: "https://api.openai.com",
      path: "/p",
      headers: {},
      body: Buffer.from(JSON.stringify({ email: "a@b.com" })),
    },
    { ...config, redact: [/\S+@\S+/g] },
  );
  expect(request.body).toEqual({ email: "[REDACTED]" });
});

test("gzip response decoded", () => {
  const r = captureResponse(
    200,
    { "content-type": "application/json", "content-encoding": "gzip", "set-cookie": "s=1" },
    gzipSync('{"ok":true}'),
    [],
    config,
  );
  expect(r).toEqual({
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  });
});

test.each([
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
])("%s response decoded", (encoding, compress) => {
  const r = captureResponse(
    200,
    { "content-type": "application/json", "content-encoding": encoding },
    compress('{"ok":true}'),
    [],
    config,
  );
  expect(r.body).toEqual({ ok: true });
});

test("unsupported content-encoding throws", () => {
  expect(() =>
    captureResponse(200, { "content-encoding": "zstd" }, Buffer.from("x"), [], config),
  ).toThrow(/zstd/);
});

test("event streams become events, other types become text", () => {
  const sse = captureResponse(
    200,
    { "content-type": "text/event-stream; charset=utf-8" },
    Buffer.from('data: {"a":1}\n\ndata: [DONE]\n\n'),
    [],
    config,
  );
  expect(sse.events).toEqual([{ data: { a: 1 } }, { text: "[DONE]" }]);
  const text = captureResponse(
    502,
    { "content-type": "text/html" },
    Buffer.from("<h1>bad gateway</h1>"),
    [],
    config,
  );
  expect(text).toEqual({
    status: 502,
    headers: { "content-type": "text/html" },
    text: "<h1>bad gateway</h1>",
  });
});

test("captureResponse scrubs secrets", () => {
  const r = captureResponse(
    200,
    { "content-type": "application/json" },
    Buffer.from('{"echo":"sk-test-SECRET123"}'),
    ["sk-test-SECRET123"],
    config,
  );
  expect(JSON.stringify(r)).not.toContain("SECRET123");
});

test("encodeResponse never sends content-encoding or content-length", () => {
  const encoded = encodeResponse({
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": "9",
    },
    body: { ok: true },
  });
  expect(encoded.headers).toEqual({ "content-type": "application/json" });
  expect(Buffer.concat(encoded.chunks).toString()).toBe('{"ok":true}');
});

test("encodeResponse sends one chunk per event, then text as one chunk", () => {
  const sse = encodeResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    events: [{ data: 1 }, { data: 2 }, { text: "[DONE]" }],
  });
  expect(sse.chunks.map(String)).toEqual(["data: 1\n\n", "data: 2\n\n", "data: [DONE]\n\n"]);
  expect(encodeResponse({ status: 200, headers: {}, text: "hi" }).chunks.map(String)).toEqual([
    "hi",
  ]);
});

test.each([
  [408, true],
  [409, true],
  [429, true],
  [500, true],
  [503, true],
  [400, false],
  [404, false],
  [200, false],
])("transient %d", (status, transient) => {
  expect(isTransientStatus(status)).toBe(transient);
});

test("errorResponse has the shape both SDKs read", () => {
  expect(errorResponse("boom")).toEqual({
    status: 400,
    headers: { "content-type": "application/json" },
    body: { type: "error", error: { type: "agent_retrace_error", message: "boom" } },
  });
});
