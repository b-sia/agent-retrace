/**
 * Request fixtures for the semantic diff tests: one support-agent request per
 * provider API shape, with the same system prompt, user message and tool.
 */
import type { JsonValue, RecordedRequest } from "../../../src/recording/format.js";

/** Fields a test can change on any fixture. */
export interface FixtureOverrides {
  /** Model id. */
  model?: string;
  /** System prompt text. */
  system?: string;
  /** First user message. */
  user?: string;
  /** Tool definitions in the provider's own shape, replacing the default tool. */
  tools?: JsonValue[];
  /** Top-level parameters, replacing `{ temperature: 0 }`. */
  params?: Record<string, JsonValue>;
}

const SYSTEM = "You are a support agent.";
const USER = "My order arrived broken";
const ORDER_SCHEMA: JsonValue = {
  type: "object",
  properties: { orderId: { type: "string" } },
  required: ["orderId"],
};

/**
 * Builds an OpenAI Chat Completions request.
 *
 * @param o - Fields to change.
 * @returns The request.
 */
export function openaiChat(o: FixtureOverrides = {}): RecordedRequest {
  return {
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    body: {
      model: o.model ?? "gpt-5",
      messages: [
        { role: "system", content: o.system ?? SYSTEM },
        { role: "user", content: o.user ?? USER },
      ],
      tools: o.tools ?? [
        { type: "function", function: { name: "lookup_order", parameters: ORDER_SCHEMA } },
      ],
      ...(o.params ?? { temperature: 0 }),
    },
  };
}

/**
 * Builds an OpenAI Responses API request.
 *
 * @param o - Fields to change.
 * @returns The request.
 */
export function openaiResponses(o: FixtureOverrides = {}): RecordedRequest {
  return {
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    headers: {},
    body: {
      model: o.model ?? "gpt-5",
      instructions: o.system ?? SYSTEM,
      input: [{ role: "user", content: [{ type: "input_text", text: o.user ?? USER }] }],
      tools: o.tools ?? [{ type: "function", name: "lookup_order", parameters: ORDER_SCHEMA }],
      ...(o.params ?? { temperature: 0 }),
    },
  };
}

/**
 * Builds an Anthropic Messages API request.
 *
 * @param o - Fields to change.
 * @returns The request.
 */
export function anthropicMessages(o: FixtureOverrides = {}): RecordedRequest {
  return {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    body: {
      model: o.model ?? "claude-sonnet-5-5",
      system: [{ type: "text", text: o.system ?? SYSTEM }],
      messages: [{ role: "user", content: o.user ?? USER }],
      tools: o.tools ?? [{ name: "lookup_order", input_schema: ORDER_SCHEMA }],
      ...(o.params ?? { temperature: 0 }),
    },
  };
}

/** The default tool's schema, for tests that change it. */
export const orderSchema = ORDER_SCHEMA;
