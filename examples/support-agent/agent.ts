/**
 * An example customer support agent: the official `@anthropic-ai/sdk`
 * Messages API with client tools, and a loop that runs the tools Claude asks
 * for until it gives a final answer.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AgentRetraceError } from "agent-retrace";
import { issueRefund, lookupOrder, searchPolicies } from "./tools.js";

/** The model the example was recorded with. It is part of the match key. */
export const MODEL = "claude-opus-5-5";

/** The most model calls one run may make before giving up. */
export const MAX_TURNS = 6;

/** What the agent decided to do, and what it tells the customer. */
export interface SupportResult {
  action: "refund" | "replace" | "escalate" | "answer";
  reply: string;
}

/** Options for `runSupportAgent()`. */
export interface SupportAgentOptions {
  /** Replaces `DEFAULT_SYSTEM_PROMPT`. */
  systemPrompt?: string;
  /** The client to use. Defaults to one built from `ANTHROPIC_API_KEY`. */
  client?: Anthropic;
}

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a customer support agent for an online home goods store.",
  "Look up the order before you act on it, and check the store policies before you refund or replace anything.",
  "Refund damaged or broken items with the issue_refund tool.",
  "Choose exactly one action: refund, replace, escalate (a human must decide) or answer (you only gave information).",
  "Keep the reply short and friendly.",
].join("\n");

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "lookup_order",
    description: "Looks up an order by id: item, status, total and delivery dates.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
  },
  {
    name: "issue_refund",
    description: "Refunds an order in full.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { orderId: { type: "string" }, reason: { type: "string" } },
      required: ["orderId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "search_policies",
    description: "Searches the store policies.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/** The shape of the final answer, enforced by structured outputs. */
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["refund", "replace", "escalate", "answer"] },
    reply: { type: "string" },
  },
  required: ["action", "reply"],
  additionalProperties: false,
};

const ACTIONS: ReadonlySet<string> = new Set(["refund", "replace", "escalate", "answer"]);

/**
 * Runs one tool call Claude asked for.
 *
 * @param block - The `tool_use` block.
 * @returns The `tool_result` block to send back; a failed tool is an error
 *   result, so Claude sees the failure and can recover.
 * @throws {AgentRetraceError} When agent-retrace reports a change or a misuse
 *   at this tool step. That is a test failure, not something for Claude to
 *   recover from, so it is not turned into a tool result.
 */
async function runTool(
  block: Anthropic.Beta.BetaToolUseBlock,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  try {
    let result: unknown;
    switch (block.name) {
      case "lookup_order":
        result = await lookupOrder(block.input as { orderId: string });
        break;
      case "issue_refund":
        result = await issueRefund(block.input as { orderId: string; reason: string });
        break;
      case "search_policies":
        result = await searchPolicies(block.input as { query: string });
        break;
      default:
        throw new Error(`Unknown tool ${block.name}.`);
    }
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (err) {
    if (err instanceof AgentRetraceError) throw err;
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    };
  }
}

/**
 * Reads the agent's final answer.
 *
 * @param message - The final assistant message.
 * @returns The action and reply.
 * @throws {Error} When the message is not a valid support result, including
 *   when it is not JSON at all.
 */
function parseResult(message: Anthropic.Beta.BetaMessage): SupportResult {
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`Final answer is not a support result: ${text}`, { cause: err });
  }
  const isObject = typeof value === "object" && value !== null;
  const { action, reply } = (isObject ? value : {}) as Record<string, unknown>;
  if (typeof action !== "string" || !ACTIONS.has(action) || typeof reply !== "string") {
    throw new Error(`Final answer is not a support result: ${text}`);
  }
  return { action: action as SupportResult["action"], reply };
}

/**
 * Reports whether an environment variable holds a value, by the SDK's own
 * rule: empty or whitespace-only counts as unset. CI commonly sets
 * `ANTHROPIC_API_KEY: ${{ secrets.X }}`, which is empty on fork PRs.
 *
 * @param name - The variable name.
 * @returns True when the variable is set to something other than whitespace.
 */
function isEnvSet(name: string): boolean {
  return (process.env[name]?.trim() ?? "") !== "";
}

/**
 * Builds the default client. A replay never reaches the network, so when no
 * credentials are set a placeholder key lets the committed recordings run
 * with no `ANTHROPIC_API_KEY` at all.
 *
 * @returns An Anthropic client.
 */
function defaultClient(): Anthropic {
  const hasCredentials = isEnvSet("ANTHROPIC_API_KEY") || isEnvSet("ANTHROPIC_AUTH_TOKEN");
  return hasCredentials ? new Anthropic() : new Anthropic({ apiKey: "unset-replay-only" });
}

/**
 * Handles one customer message: calls Claude, runs the tools it asks for,
 * and repeats until Claude answers without a tool call.
 *
 * @param message - The customer's message.
 * @param opts - System prompt and client overrides.
 * @returns The action taken and the reply to the customer.
 * @throws {Error} When Claude refuses, runs out of tokens, is still calling
 *   tools after `MAX_TURNS` calls, or its final answer is not a support result.
 */
export async function runSupportAgent(
  message: string,
  opts: SupportAgentOptions = {},
): Promise<SupportResult> {
  const client = opts.client ?? defaultClient();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: message }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      tools: TOOLS,
      output_config: { effort: "medium", format: { type: "json_schema", schema: RESULT_SCHEMA } },
      // On a safety decline, the API re-runs the request on a fallback model
      // chosen by the decline category, inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined: ${response.stop_details?.explanation ?? "no reason"}`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("Claude ran out of output tokens before finishing.");
    }
    // The whole content goes back, thinking blocks included, as the API requires.
    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) return parseResult(response);
    // Tools run one at a time, in the order Claude asked for them, so a
    // recording sees the same sequence of steps on every run. All results go
    // back in a single user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of toolUses) results.push(await runTool(block));
    messages.push({ role: "user", content: results });
  }
  throw new Error(`The agent was still calling tools after ${MAX_TURNS} model calls.`);
}
