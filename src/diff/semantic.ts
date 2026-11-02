/**
 * Provider-specific request parsing: turns a recorded request into the parts
 * a person reads when an agent changes (system prompt, messages, tools,
 * parameters). Pure, no I/O. Never throws: a body that does not have the
 * expected shape yields empty parts, and the renderer falls back to a raw diff.
 */
import type { RecordedRequest } from "../recording/format.js";
import { asArray, asString, isObject, type JsonObject, type JsonValue } from "../recording/json.js";
import { oneLine } from "../terminal.js";

/** The provider APIs the semantic view understands. */
export type ApiShape = "openai-chat" | "openai-responses" | "anthropic-messages" | "unknown";

/** The meaningful parts of one LLM request. */
export interface SemanticRequest {
  api: ApiShape;
  /** Method, host and path with query, e.g. "POST api.openai.com/v1/chat/completions". */
  endpoint: string;
  model?: string;
  /** System and developer instructions, joined with "\n". */
  system: string;
  /** One rendered line per message, tool call or tool result. */
  messages: string[];
  /** Tool name mapped to its input schema. */
  tools: Map<string, JsonValue>;
  /** Every other top-level body field. */
  params: Record<string, JsonValue>;
}

// Body fields that have their own section, so they are not params.
const NON_PARAMS = new Set(["model", "messages", "input", "instructions", "system", "tools"]);

/**
 * Flattens message content to text. A string is itself; an array of parts
 * joins the text of text parts, and stands in `[type]` for anything else
 * (images, files, audio) so its position stays visible.
 *
 * @param content - A message's content.
 * @param separator - Joins the parts.
 * @returns The text.
 */
function contentText(content: JsonValue | undefined, separator = " "): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isObject(part)) return "";
      const text = asString(part.text);
      return text ?? `[${asString(part.type) ?? "part"}]`;
    })
    .filter((s) => s !== "")
    .join(separator);
}

/**
 * Copies a JSON value with every object's keys sorted by code unit, so two
 * values that differ only in key order are written identically.
 *
 * @param value - Any JSON value.
 * @returns The sorted copy.
 */
function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
}

/**
 * Renders tool call arguments compactly, with sorted keys. Arguments that are
 * a JSON string (OpenAI) are parsed and re-written without whitespace;
 * anything that does not parse is shown as sent.
 *
 * @param args - The arguments, as a JSON string or a JSON value.
 * @returns The compact text.
 */
function compactArgs(args: JsonValue | undefined): string {
  if (typeof args !== "string") return JSON.stringify(sortKeys(args ?? {}));
  try {
    return JSON.stringify(sortKeys(JSON.parse(args)));
  } catch {
    return args;
  }
}

/**
 * Renders a tool call line.
 *
 * @param name - The tool name.
 * @param args - Its arguments.
 * @returns The line.
 */
export function toolCallLine(name: JsonValue | undefined, args: JsonValue | undefined): string {
  return `assistant -> tool_call ${asString(name) ?? "?"}(${oneLine(compactArgs(args))})`;
}

/**
 * Renders a tool result line.
 *
 * @param id - The tool call id the result answers.
 * @param content - The result content.
 * @returns The line.
 */
function toolResultLine(id: JsonValue | undefined, content: JsonValue | undefined): string {
  const text = typeof content === "string" || Array.isArray(content) ? contentText(content) : "";
  const shown = text !== "" || content === undefined ? text : JSON.stringify(content);
  return `tool_result(${asString(id) ?? "?"}): ${oneLine(shown)}`;
}

/**
 * Renders a plain message line, or nothing when it has no text.
 *
 * @param role - The message role.
 * @param content - The message content.
 * @returns Zero or one lines.
 */
function textLines(role: JsonValue | undefined, content: JsonValue | undefined): string[] {
  const text = contentText(content);
  return text === "" ? [] : [`${asString(role) ?? "unknown"}: ${oneLine(text)}`];
}

/**
 * Reports whether a role carries instructions rather than conversation.
 *
 * @param role - A message role.
 * @returns True for system and developer.
 */
function isSystemRole(role: JsonValue | undefined): boolean {
  return role === "system" || role === "developer";
}

/**
 * Reads an OpenAI Chat Completions body.
 *
 * @param body - The request body.
 * @returns System text, message lines and tools.
 */
function openaiChat(body: JsonObject): Pick<SemanticRequest, "system" | "messages" | "tools"> {
  const system: string[] = [];
  const messages: string[] = [];
  for (const m of asArray(body.messages)) {
    if (!isObject(m)) continue;
    if (isSystemRole(m.role)) {
      system.push(contentText(m.content));
    } else if (m.role === "tool") {
      messages.push(toolResultLine(m.tool_call_id, m.content));
    } else {
      messages.push(...textLines(m.role, m.content));
      for (const call of asArray(m.tool_calls)) {
        const fn = isObject(call) && isObject(call.function) ? call.function : {};
        messages.push(toolCallLine(fn.name, fn.arguments));
      }
    }
  }
  const tools = new Map<string, JsonValue>();
  for (const t of asArray(body.tools)) {
    if (!isObject(t)) continue;
    const fn = isObject(t.function) ? t.function : undefined;
    const name = asString(fn?.name) ?? asString(t.type);
    if (name !== undefined) tools.set(name, fn?.parameters ?? t);
  }
  return { system: system.join("\n"), messages, tools };
}

/**
 * Reads an OpenAI Responses API body.
 *
 * @param body - The request body.
 * @returns System text, message lines and tools.
 */
function openaiResponses(body: JsonObject): Pick<SemanticRequest, "system" | "messages" | "tools"> {
  const system: string[] = [];
  const instructions = asString(body.instructions);
  if (instructions !== undefined) system.push(instructions);
  const messages: string[] = [];
  if (typeof body.input === "string") messages.push(`user: ${oneLine(body.input)}`);
  for (const item of asArray(body.input)) {
    if (!isObject(item)) continue;
    const type = asString(item.type) ?? "message";
    if (type === "message" && isSystemRole(item.role)) {
      system.push(contentText(item.content));
    } else if (type === "message") {
      messages.push(...textLines(item.role, item.content));
    } else if (type === "function_call") {
      messages.push(toolCallLine(item.name, item.arguments));
    } else if (type === "function_call_output") {
      messages.push(toolResultLine(item.call_id, item.output));
    } else {
      // Reasoning items, built-in tool calls and the like: their payloads are
      // opaque, so only their position is shown.
      messages.push(`[${oneLine(type)}]`);
    }
  }
  const tools = new Map<string, JsonValue>();
  for (const t of asArray(body.tools)) {
    if (!isObject(t)) continue;
    // Built-in tools (web_search, file_search) have a type and no name.
    const name = asString(t.name) ?? asString(t.type);
    if (name !== undefined) tools.set(name, t.parameters ?? t);
  }
  return { system: system.join("\n"), messages, tools };
}

/**
 * Reads an Anthropic Messages API body.
 *
 * @param body - The request body.
 * @returns System text, message lines and tools.
 */
function anthropicMessages(
  body: JsonObject,
): Pick<SemanticRequest, "system" | "messages" | "tools"> {
  const messages: string[] = [];
  for (const m of asArray(body.messages)) {
    if (!isObject(m)) continue;
    if (!Array.isArray(m.content)) {
      messages.push(...textLines(m.role, m.content));
      continue;
    }
    // Text and media blocks become one line; tool blocks get a line each.
    const parts: JsonValue[] = [];
    const tools: string[] = [];
    for (const block of m.content) {
      if (isObject(block) && block.type === "tool_use") {
        tools.push(toolCallLine(block.name, block.input));
      } else if (isObject(block) && block.type === "tool_result") {
        tools.push(toolResultLine(block.tool_use_id, block.content));
      } else {
        parts.push(block);
      }
    }
    messages.push(...textLines(m.role, parts), ...tools);
  }
  const tools = new Map<string, JsonValue>();
  for (const t of asArray(body.tools)) {
    if (!isObject(t)) continue;
    // Server tools (web_search_20250305) have a name and no input_schema.
    const name = asString(t.name) ?? asString(t.type);
    if (name !== undefined) tools.set(name, t.input_schema ?? t);
  }
  // Each system block is its own paragraph, as separate system messages are
  // for OpenAI, so the prompt is diffed line by line.
  return { system: contentText(body.system, "\n"), messages, tools };
}

/**
 * Parses a URL, or returns undefined when it is not one.
 *
 * @param url - The URL text.
 * @returns The URL.
 */
function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * Works out which provider API a request is for, from its URL path. The host
 * is only consulted for `/messages`, a path common enough to be ambiguous;
 * Anthropic requests behind a gateway still carry `anthropic-version`.
 *
 * @param req - The request.
 * @param url - Its parsed URL.
 * @returns The API shape.
 */
function detectApi(req: RecordedRequest, url: URL | undefined): ApiShape {
  const path = url?.pathname.replace(/\/+$/, "") ?? "";
  if (path.endsWith("/chat/completions")) return "openai-chat";
  if (path.endsWith("/responses")) return "openai-responses";
  if (
    path.endsWith("/messages") &&
    (req.headers["anthropic-version"] !== undefined || url?.hostname === "api.anthropic.com")
  ) {
    return "anthropic-messages";
  }
  return "unknown";
}

/**
 * Extracts the meaningful parts of an LLM request.
 *
 * @param req - The recorded (or live, captured) request.
 * @returns The semantic request.
 */
export function toSemantic(req: RecordedRequest): SemanticRequest {
  const url = parseUrl(req.url);
  // `host` includes the port only when it is not the scheme's default.
  const endpoint = `${req.method} ${url ? `${url.host}${url.pathname}${url.search}` : req.url}`;
  const body = isObject(req.body) ? req.body : {};
  const api = detectApi(req, url);
  const model = asString(body.model);
  const empty = { system: "", messages: [], tools: new Map<string, JsonValue>(), params: {} };
  if (api === "unknown") return { api, endpoint, model, ...empty };
  const parts =
    api === "openai-chat"
      ? openaiChat(body)
      : api === "openai-responses"
        ? openaiResponses(body)
        : anthropicMessages(body);
  const params: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!NON_PARAMS.has(key)) params[key] = value;
  }
  return { api, endpoint, model, ...parts, params };
}
