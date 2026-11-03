/**
 * SDK compatibility: the official `@anthropic-ai/sdk` client, Messages API
 * streaming and not, with a tool-use round trip, recorded against the fake
 * provider and replayed with the provider shut down.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetConfig } from "../../src/config.js";
import { configure, replay } from "../../src/index.js";
import { expectChangeReport } from "../support/change-error.js";
import { type FakeProvider, startFakeProvider, toolThenText } from "../support/fake-provider.js";

const API_KEY = "sk-test-SECRET123456";
const WEATHER_CALL = { id: "toolu_weather_1", name: "get_weather", args: { city: "Paris" } };
const ANSWER = "It is sunny in Paris.";

let fake: FakeProvider;
let client: Anthropic;
let dir: string;

beforeEach(async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
  fake = await startFakeProvider();
  client = new Anthropic({ baseURL: fake.baseURL, apiKey: API_KEY, maxRetries: 2 });
  configure({ providerHosts: [fake.host] });
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-anthropic-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetConfig();
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * The local tool the agent calls.
 *
 * @param args - Tool arguments.
 * @returns A weather report.
 */
function getWeather(args: { city: string }): string {
  return `sunny, 21C in ${args.city}`;
}

/**
 * Sends one Messages request and returns the assistant message.
 *
 * @param c - The Anthropic client.
 * @param stream - Whether to stream.
 * @param params - Request parameters.
 * @returns The final message.
 */
async function send(
  c: Anthropic,
  stream: boolean,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  if (!stream) return c.messages.create(params);
  return c.messages.stream(params).finalMessage();
}

/**
 * An agent that loops until the model stops asking for tools.
 *
 * @param c - The Anthropic client.
 * @param stream - Whether to stream every call.
 * @param system - The system prompt.
 * @returns The tool uses made and the final answer.
 */
async function runAgent(
  c: Anthropic,
  stream: boolean,
  system = "You are a weather assistant.",
): Promise<{ toolUses: { id: string; name: string; input: unknown }[]; answer: string }> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "What is the weather in Paris?" },
  ];
  const tools: Anthropic.Tool[] = [
    {
      name: "get_weather",
      description: "Current weather for a city",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];
  const toolUses: { id: string; name: string; input: unknown }[] = [];
  for (let turn = 0; turn < 5; turn++) {
    const msg = await send(c, stream, {
      model: "claude-test",
      max_tokens: 256,
      system,
      messages,
      tools,
    });
    const uses = msg.content.flatMap((b) => (b.type === "tool_use" ? [b] : []));
    if (msg.stop_reason !== "tool_use" || uses.length === 0) {
      const answer = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { toolUses, answer };
    }
    messages.push({ role: "assistant", content: msg.content });
    messages.push({
      role: "user",
      content: uses.map((u) => ({
        type: "tool_result" as const,
        tool_use_id: u.id,
        content: getWeather(u.input as { city: string }),
      })),
    });
    toolUses.push(...uses.map((u) => ({ id: u.id, name: u.name, input: u.input })));
  }
  throw new Error("agent did not finish in 5 turns");
}

test.each([false, true])("anthropic messages (stream=%s) record -> replay", async (stream) => {
  fake.reply(() => ({ text: ANSWER }));
  const run = async (): Promise<string> =>
    (
      await send(client, stream, {
        model: "claude-test",
        max_tokens: 256,
        messages: [{ role: "user", content: "Hello" }],
      })
    ).content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
  const first = await replay(`an-msg-${stream}`, run, { dir });
  expect(first).toBe(ANSWER);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]?.headers["anthropic-version"]).toBeDefined();

  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  await fake.close();
  expect(await replay(`an-msg-${stream}`, run, { dir })).toBe(first);
});

test.each([false, true])(
  "anthropic tool-use round trip (stream=%s) record -> replay",
  async (stream) => {
    fake.reply(toolThenText(WEATHER_CALL, ANSWER));
    const first = await replay(`an-tool-${stream}`, () => runAgent(client, stream), { dir });
    expect(fake.calls).toHaveLength(2);
    expect(first).toEqual({
      toolUses: [{ id: "toolu_weather_1", name: "get_weather", input: { city: "Paris" } }],
      answer: ANSWER,
    });

    vi.stubEnv("AGENT_RETRACE_MODE", "replay");
    await fake.close();
    expect(await replay(`an-tool-${stream}`, () => runAgent(client, stream), { dir })).toEqual(
      first,
    );
  },
);

test("system prompt change -> step 1 of 2 with system diff", async () => {
  fake.reply(toolThenText(WEATHER_CALL, ANSWER));
  await replay("an-sys", () => runAgent(client, false), { dir });
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  await fake.close();
  await expectChangeReport(
    replay("an-sys", () => runAgent(client, false, "New system prompt"), { dir }),
    /changed at step 1 of 2[\s\S]*System prompt:[\s\S]*\+ New system prompt/,
  );
});
