/**
 * Conversion between raw HTTP traffic (as the dispatcher sees it) and the
 * request and response shapes stored in a recording. Pure, no I/O.
 */
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { AgentRetraceConfig } from "../config.js";
import {
  KEPT_RESPONSE_HEADERS,
  MATCHED_REQUEST_HEADERS,
  redactDeep,
  scrubSecrets,
  secretsFromHeaders,
} from "../match/normalize.js";
import type { JsonValue, RecordedRequest, RecordedResponse } from "../recording/format.js";
import { parseSse, serializeSse } from "./sse.js";

/** A request as the dispatcher received it. */
export interface RawRequest {
  method: string;
  /** Scheme, host and port, e.g. `https://api.openai.com`. */
  origin: string;
  /** Path and query string. */
  path: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
}

/** Environment variables whose values are provider keys that may be echoed in a body. */
const KEY_ENV_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

/**
 * Lowercases the names of a header record. When two names differ only in
 * case, the later one wins.
 *
 * @param headers - Headers with names in any case.
 * @returns A new record with lowercase names.
 */
function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * Picks the headers in an allow list.
 *
 * @param headers - Headers with lowercase names.
 * @param allowed - Names to keep.
 * @returns The kept headers, in allow-list order.
 */
function pick(headers: Record<string, string>, allowed: readonly string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of allowed) {
    const value = headers[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/**
 * Turns an outgoing request into the form stored in a recording, and collects
 * the credentials that must never be written.
 *
 * Only the headers that take part in matching are kept. A JSON body is stored
 * parsed, anything else as text. User redaction rules run first, then every
 * known credential is scrubbed, including provider keys from the environment
 * in case a prompt or tool result echoes them.
 *
 * @param input - The request as sent.
 * @param config - Configuration supplying the redaction rules.
 * @returns The redacted request, and the secrets that were scrubbed from it.
 */
export function captureRequest(
  input: RawRequest,
  config: AgentRetraceConfig,
): { request: RecordedRequest; secrets: string[] } {
  const headers = lowercaseKeys(input.headers);
  const secrets = secretsFromHeaders(headers);
  for (const name of KEY_ENV_VARS) {
    const value = process.env[name];
    if (value) secrets.push(value);
  }
  const request: RecordedRequest = {
    method: input.method.toUpperCase(),
    url: `${input.origin}${input.path}`,
    headers: pick(headers, MATCHED_REQUEST_HEADERS),
  };
  if (input.body !== undefined && input.body.length > 0) {
    const text = input.body.toString("utf8");
    try {
      request.body = JSON.parse(text) as JsonValue;
    } catch {
      request.text = text;
    }
  }
  return { request: finish(request, secrets, config), secrets };
}

/**
 * Applies the user's redaction rules, then scrubs secrets.
 *
 * @param value - A recorded request or response.
 * @param secrets - Credentials to remove.
 * @param config - Configuration supplying the redaction rules.
 * @returns The cleaned value.
 */
function finish<T extends RecordedRequest | RecordedResponse>(
  value: T,
  secrets: readonly string[],
  config: AgentRetraceConfig,
): T {
  const redacted = redactDeep(value as unknown as JsonValue, config.redact);
  return scrubSecrets(redacted, secrets) as unknown as T;
}

/**
 * Decodes a response body according to its `content-encoding`.
 *
 * Node's `fetch` decompresses on top of the dispatcher, so the dispatcher
 * sees the compressed bytes. A recording must hold readable text.
 *
 * @param body - The raw bytes.
 * @param encoding - The `content-encoding` header, possibly a list.
 * @returns The decoded bytes.
 * @throws {Error} When the encoding is not gzip, deflate, br or identity.
 */
function decode(body: Buffer, encoding: string | undefined): Buffer {
  if (encoding === undefined) return body;
  // Encodings are listed in the order they were applied, so undo them backwards.
  const names = encoding
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "identity")
    .reverse();
  let out = body;
  for (const name of names) {
    if (name === "gzip" || name === "x-gzip") out = gunzipSync(out);
    else if (name === "deflate") out = inflateSync(out);
    else if (name === "br") out = brotliDecompressSync(out);
    else {
      throw new Error(
        `agent-retrace cannot record a response with content-encoding ${JSON.stringify(name)}. Supported encodings are gzip, deflate and br.`,
      );
    }
  }
  return out;
}

/**
 * Turns a provider response into the form stored in a recording.
 *
 * @param status - HTTP status code.
 * @param headers - Response headers.
 * @param body - The raw body bytes, possibly compressed.
 * @param secrets - Credentials to scrub, from `captureRequest`.
 * @param config - Configuration supplying the redaction rules.
 * @returns The redacted response: decoded, with only the replayable headers.
 * @throws {Error} When the body uses an unsupported `content-encoding`.
 */
export function captureResponse(
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  secrets: readonly string[],
  config: AgentRetraceConfig,
): RecordedResponse {
  const lower = lowercaseKeys(headers);
  const text = decode(body, lower["content-encoding"]).toString("utf8");
  const type = (lower["content-type"] ?? "").toLowerCase();
  const response: RecordedResponse = { status, headers: pick(lower, KEPT_RESPONSE_HEADERS) };
  if (type.includes("text/event-stream")) {
    response.events = parseSse(text);
  } else if (type.includes("json")) {
    try {
      response.body = JSON.parse(text) as JsonValue;
    } catch {
      response.text = text;
    }
  } else {
    response.text = text;
  }
  return finish(response, secrets, config);
}

/**
 * Turns a recorded response into what the dispatcher plays back. Streams get
 * one chunk per event. `content-encoding` and `content-length` are never set:
 * the body is plain, and the length would be wrong if the file was edited.
 *
 * @param r - The recorded response.
 * @returns Status, headers and body chunks.
 */
export function encodeResponse(r: RecordedResponse): {
  status: number;
  headers: Record<string, string>;
  chunks: Buffer[];
} {
  const headers = Object.fromEntries(
    Object.entries(r.headers).filter(
      ([name]) => !["content-encoding", "content-length"].includes(name.toLowerCase()),
    ),
  );
  let chunks: Buffer[];
  if (r.events !== undefined) chunks = serializeSse(r.events).map((s) => Buffer.from(s));
  else if (r.body !== undefined) chunks = [Buffer.from(JSON.stringify(r.body))];
  else chunks = r.text ? [Buffer.from(r.text)] : [];
  return { status: r.status, headers, chunks };
}

/**
 * Reports whether a status is a failure the SDKs retry, so the response is
 * not worth recording: replaying it would just make the SDK retry too.
 *
 * @param status - HTTP status code.
 * @returns True for 408, 409, 429 and 5xx.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Builds the response sent in place of a provider call that agent-retrace
 * refused. A 400 is used, not a network error: both the OpenAI and Anthropic
 * SDKs retry connection errors with backoff but not a 400, and both read
 * `error.message` from this body.
 *
 * @param message - What went wrong.
 * @returns A 400 response with an Anthropic-style error body.
 */
export function errorResponse(message: string): RecordedResponse {
  return {
    status: 400,
    headers: { "content-type": "application/json" },
    body: { type: "error", error: { type: "agent_retrace_error", message } },
  };
}
