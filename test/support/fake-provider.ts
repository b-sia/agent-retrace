/**
 * A fake LLM provider for the SDK compatibility suite. It speaks enough of the
 * OpenAI Chat Completions, OpenAI Responses and Anthropic Messages wire
 * formats, streaming and not, for the real SDKs to parse its answers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { JsonValue } from "../../src/index.js";
import { startServer } from "./http-server.js";

/** What the fake answers with: plain text, or a single tool call. */
export interface FakeReply {
  /** Assistant text. */
  text?: string;
  /** A tool call; takes precedence over `text`. */
  toolCall?: { id: string; name: string; args: Record<string, JsonValue> };
}

/** One request the fake received. */
export interface FakeCall {
  /** URL path, e.g. `/v1/chat/completions`. */
  path: string;
  /** Parsed JSON request body. */
  body: JsonValue;
  /** Request headers, lower-cased names, multi-values joined with ", ". */
  headers: Record<string, string>;
}

/** A running fake provider. */
export interface FakeProvider {
  /** Base URL without a path, e.g. `http://127.0.0.1:41234`. */
  baseURL: string;
  /** `127.0.0.1:<port>`, the form `configure({ providerHosts })` accepts. */
  host: string;
  /** Every request received, including those answered with a 429. */
  calls: FakeCall[];
  /**
   * Sets how the fake answers. The default answers every call with the text "ok".
   *
   * @param fn - Picks the reply for a call.
   */
  reply(fn: (call: { path: string; body: JsonValue }) => FakeReply): void;
  /** Stops the server and drops open connections. */
  close(): Promise<void>;
}

/** Options for {@link startFakeProvider}. */
export interface FakeProviderOptions {
  /** Gzip every response body and set `content-encoding: gzip`. */
  gzip?: boolean;
  /** Answer the first n calls with a 429 rate limit error. */
  failFirst?: number;
  /** Add a `set-cookie` header to every response. */
  setCookie?: boolean;
}

type JsonObject = { [key: string]: JsonValue };

/** Fixed timestamp so recordings and replies are deterministic. */
const CREATED = 1_700_000_000;

/**
 * Starts a fake provider on a random port of 127.0.0.1.
 *
 * @param opts - Behavior switches for compression, rate limits and cookies.
 * @returns The running fake.
 */
export async function startFakeProvider(opts: FakeProviderOptions = {}): Promise<FakeProvider> {
  let pick: (call: { path: string; body: JsonValue }) => FakeReply = () => ({ text: "ok" });
  const calls: FakeCall[] = [];
  let failuresLeft = opts.failFirst ?? 0;

  const server = await startServer((req, res, raw) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = (raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null) as JsonValue;
    calls.push({ path, body, headers: flatHeaders(req) });
    const id = `req_${calls.length}`;
    const send = (status: number, contentType: string, payload: string): void =>
      respond(res, opts, id, status, contentType, payload);

    if (failuresLeft > 0) {
      failuresLeft--;
      const error = path.endsWith("/messages")
        ? { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }
        : { error: { message: "Rate limited", type: "rate_limit_error", param: null, code: null } };
      // retry-after: 0 keeps SDK retries instant while recording.
      res.setHeader("retry-after", "0");
      res.setHeader("retry-after-ms", "0");
      send(429, "application/json", JSON.stringify(error));
      return;
    }

    const request = (body ?? {}) as JsonObject;
    const reply = pick({ path, body });
    const stream = request.stream === true;
    const model = typeof request.model === "string" ? request.model : "fake-model";
    let out: { json: JsonValue } | { events: SseOut[] };
    if (path.endsWith("/chat/completions")) {
      const usage = request.stream_options !== undefined;
      out = stream
        ? { events: chatChunks(model, reply, usage) }
        : { json: chatCompletion(model, reply) };
    } else if (path.endsWith("/responses")) {
      out = stream
        ? { events: responseEvents(model, reply) }
        : { json: responseObject(model, reply, "completed") };
    } else if (path.endsWith("/messages")) {
      out = stream
        ? { events: messageEvents(model, reply) }
        : { json: anthropicMessage(model, reply) };
    } else {
      send(404, "application/json", JSON.stringify({ error: { message: `no route ${path}` } }));
      return;
    }
    if ("json" in out) send(200, "application/json", JSON.stringify(out.json));
    else send(200, "text/event-stream; charset=utf-8", sse(out.events));
  });

  return {
    baseURL: server.url,
    host: server.host,
    calls,
    reply(fn) {
      pick = fn;
    },
    close: () => server.close(),
  };
}

/**
 * Builds a reply function for a two-call tool round trip: the first call (no
 * tool result in the request yet) gets the tool call, later calls get the text.
 *
 * @param toolCall - The tool call to make first.
 * @param text - The final answer.
 * @returns A function for {@link FakeProvider.reply}.
 */
export function toolThenText(
  toolCall: NonNullable<FakeReply["toolCall"]>,
  text: string,
): (call: { path: string; body: JsonValue }) => FakeReply {
  return ({ body }) => (hasToolResult(body) ? { text } : { toolCall });
}

/**
 * Tells whether a request already carries a tool result, in any of the three
 * wire formats.
 *
 * @param body - Parsed request body.
 * @returns True when a tool result is present.
 */
export function hasToolResult(body: JsonValue): boolean {
  const req = (body ?? {}) as JsonObject;
  const items = [
    ...(Array.isArray(req.messages) ? req.messages : []),
    ...(Array.isArray(req.input) ? req.input : []),
  ] as JsonObject[];
  return items.some(
    (m) =>
      m.role === "tool" ||
      m.type === "function_call_output" ||
      (Array.isArray(m.content) &&
        (m.content as JsonObject[]).some((c) => c.type === "tool_result")),
  );
}

/**
 * Collects request headers into a flat lower-case map.
 *
 * @param req - The incoming request.
 * @returns Header name to value.
 */
function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Writes a response with the headers every real provider sets.
 *
 * @param res - The server response.
 * @param opts - Fake options (gzip, cookies).
 * @param id - Request id for `x-request-id`.
 * @param status - HTTP status.
 * @param contentType - Content type.
 * @param payload - Body text.
 */
function respond(
  res: ServerResponse,
  opts: FakeProviderOptions,
  id: string,
  status: number,
  contentType: string,
  payload: string,
): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("x-request-id", id);
  if (opts.setCookie) res.setHeader("set-cookie", "__cf_bm=fake-cookie-value; Path=/; HttpOnly");
  if (opts.gzip) {
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync(payload));
  } else {
    res.end(payload);
  }
}

/** One server-sent event to emit; `event` is omitted for OpenAI chat chunks. */
interface SseOut {
  event?: string;
  data: JsonValue | "[DONE]";
}

/**
 * Serializes events in `text/event-stream` format.
 *
 * @param events - Events in order.
 * @returns The stream body.
 */
function sse(events: SseOut[]): string {
  return events
    .map((e) => {
      const data = e.data === "[DONE]" ? "[DONE]" : JSON.stringify(e.data);
      return `${e.event === undefined ? "" : `event: ${e.event}\n`}data: ${data}\n\n`;
    })
    .join("");
}

/**
 * Token usage for the Chat Completions API.
 *
 * @returns A usage object.
 */
function chatUsage(): JsonObject {
  return { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
}

/**
 * A non-streaming Chat Completions response.
 *
 * @param model - Model id echoed back.
 * @param reply - What to answer.
 * @returns A `chat.completion` object.
 */
function chatCompletion(model: string, reply: FakeReply): JsonObject {
  const call = reply.toolCall;
  const message: JsonObject = call
    ? {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }
    : { role: "assistant", content: reply.text ?? "", refusal: null };
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: CREATED,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: call ? "tool_calls" : "stop" }],
    usage: chatUsage(),
  };
}

/**
 * Streaming Chat Completions chunks, ending in `[DONE]`.
 *
 * @param model - Model id echoed back.
 * @param reply - What to answer.
 * @param usage - Whether to send a final usage chunk (`stream_options` was set).
 * @returns The events.
 */
function chatChunks(model: string, reply: FakeReply, usage: boolean): SseOut[] {
  const chunk = (delta: JsonObject, finish: string | null): SseOut => ({
    data: {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: CREATED,
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    },
  });
  const call = reply.toolCall;
  const events: SseOut[] = [chunk({ role: "assistant", content: call ? null : "" }, null)];
  if (call) {
    const args = JSON.stringify(call.args);
    const half = Math.floor(args.length / 2);
    events.push(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: "" },
            },
          ],
        },
        null,
      ),
      chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, null),
      chunk({}, "tool_calls"),
    );
  } else {
    for (const piece of splitText(reply.text ?? "")) events.push(chunk({ content: piece }, null));
    events.push(chunk({}, "stop"));
  }
  if (usage) {
    events.push({
      data: {
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: CREATED,
        model,
        choices: [],
        usage: chatUsage(),
      },
    });
  }
  events.push({ data: "[DONE]" });
  return events;
}

/**
 * The output item a Responses API reply produces.
 *
 * @param reply - What to answer.
 * @returns A `message` or `function_call` output item.
 */
function responseItem(reply: FakeReply): JsonObject {
  const call = reply.toolCall;
  if (call) {
    return {
      type: "function_call",
      id: "fc_fake",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.args),
      status: "completed",
    };
  }
  return {
    type: "message",
    id: "msg_fake",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: reply.text ?? "", annotations: [], logprobs: [] }],
  };
}

/**
 * A Responses API `response` object.
 *
 * @param model - Model id echoed back.
 * @param reply - What to answer.
 * @param status - `in_progress` (no output yet) or `completed`.
 * @returns The response object.
 */
function responseObject(
  model: string,
  reply: FakeReply,
  status: "in_progress" | "completed",
): JsonObject {
  const done = status === "completed";
  return {
    id: "resp_fake",
    object: "response",
    created_at: CREATED,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: done ? [responseItem(reply)] : [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    service_tier: "default",
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: done
      ? {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 15,
        }
      : null,
    metadata: {},
  };
}

/**
 * Streaming Responses API events, each with an `event:` line.
 *
 * @param model - Model id echoed back.
 * @param reply - What to answer.
 * @returns The events.
 */
function responseEvents(model: string, reply: FakeReply): SseOut[] {
  let seq = 0;
  const ev = (type: string, fields: JsonObject): SseOut => ({
    event: type,
    data: { type, sequence_number: seq++, ...fields },
  });
  const item = responseItem(reply);
  const events: SseOut[] = [
    ev("response.created", { response: responseObject(model, reply, "in_progress") }),
  ];
  const itemId = item.id as string;
  if (reply.toolCall) {
    events.push(
      ev("response.output_item.added", {
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      }),
    );
    const args = item.arguments as string;
    events.push(
      ev("response.function_call_arguments.delta", {
        item_id: itemId,
        output_index: 0,
        delta: args,
      }),
      ev("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: 0,
        arguments: args,
      }),
    );
  } else {
    events.push(
      ev("response.output_item.added", {
        output_index: 0,
        item: { ...item, content: [], status: "in_progress" },
      }),
    );
    for (const piece of splitText(reply.text ?? "")) {
      events.push(
        ev("response.output_text.delta", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: piece,
          logprobs: [],
        }),
      );
    }
  }
  events.push(
    ev("response.output_item.done", { output_index: 0, item }),
    ev("response.completed", { response: responseObject(model, reply, "completed") }),
  );
  return events;
}

/**
 * A non-streaming Anthropic Messages response.
 *
 * @param model - Model id echoed back.
 * @param reply - What to answer.
 * @returns A `message` object.
 */
function anthropicMessage(model: string, reply: FakeReply): JsonObject {
  const call = reply.toolCall;
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content: call
      ? [{ type: "tool_use", id: call.id, name: call.name, input: call.args }]
      : [{ type: "text", text: reply.text ?? "" }],
    stop_reason: call ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/**
 * Streaming Anthropic Messages events, each with an `event:` line.
 *
 * @param model - Model id echoed back.
 * @param reply - What to answer.
 * @returns The events.
 */
function messageEvents(model: string, reply: FakeReply): SseOut[] {
  const ev = (type: string, fields: JsonObject): SseOut => ({
    event: type,
    data: { type, ...fields },
  });
  const call = reply.toolCall;
  const start = {
    ...anthropicMessage(model, reply),
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  const events: SseOut[] = [ev("message_start", { message: start })];
  if (call) {
    events.push(
      ev("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      }),
      ev("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) },
      }),
    );
  } else {
    events.push(ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    for (const piece of splitText(reply.text ?? "")) {
      events.push(
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } }),
      );
    }
  }
  events.push(
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", {
      delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    ev("message_stop", {}),
  );
  return events;
}

/**
 * Splits text into two deltas so streaming code has something to join.
 *
 * @param text - The full text.
 * @returns One or two pieces.
 */
function splitText(text: string): string[] {
  const half = Math.ceil(text.length / 2);
  return text.length < 2 ? [text] : [text.slice(0, half), text.slice(half)];
}
