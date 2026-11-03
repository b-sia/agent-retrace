/**
 * SDK compatibility: the official `openai` client, Chat Completions and
 * Responses, streaming and not, recorded against the fake provider and
 * replayed with the provider shut down.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetConfig } from "../../src/config.js";
import { configure, type Recording, replay } from "../../src/index.js";
import { expectChangeReport } from "../support/change-error.js";
import { type FakeProvider, startFakeProvider, toolThenText } from "../support/fake-provider.js";

const API_KEY = "sk-test-SECRET123456";
const WEATHER_CALL = { id: "call_weather_1", name: "get_weather", args: { city: "Paris" } };
const ANSWER = "It is sunny in Paris.";

// Built at module load, before any replay() runs: the interceptor reads the
// global dispatcher per request, so this client is still intercepted.
const early = await startFakeProvider();
const earlyClient = new OpenAI({ baseURL: `${early.baseURL}/v1`, apiKey: API_KEY, maxRetries: 2 });

let fake: FakeProvider;
let client: OpenAI;
let dir: string;

beforeEach(async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
  fake = await startFakeProvider();
  fake.reply(toolThenText(WEATHER_CALL, ANSWER));
  client = new OpenAI({ baseURL: `${fake.baseURL}/v1`, apiKey: API_KEY, maxRetries: 2 });
  configure({ providerHosts: [fake.host, early.host] });
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-openai-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetConfig();
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await early.close();
});

/**
 * The local tool the agents call.
 *
 * @param args - Tool arguments.
 * @returns A weather report.
 */
function getWeather(args: { city: string }): string {
  return `sunny, 21C in ${args.city}`;
}

const WEATHER_PARAMETERS = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
} as const;

/**
 * A two-call Chat Completions agent: ask, run the requested tool, answer.
 *
 * @param c - The OpenAI client.
 * @param stream - Whether to stream both calls.
 * @param system - The system prompt.
 * @returns The tool calls made and the final answer.
 */
async function runChat(
  c: OpenAI,
  stream: boolean,
  system = "You are a weather assistant.",
): Promise<{ toolCalls: { id: string; name: string; arguments: string }[]; answer: string }> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: "What is the weather in Paris?" },
  ];
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    { type: "function", function: { name: "get_weather", parameters: WEATHER_PARAMETERS } },
  ];
  const turn = async (): Promise<{
    content: string;
    toolCalls: { id: string; name: string; arguments: string }[];
  }> => {
    if (!stream) {
      const res = await c.chat.completions.create({ model: "gpt-test", messages, tools });
      const msg = res.choices[0]?.message;
      const toolCalls = (msg?.tool_calls ?? []).flatMap((t) =>
        t.type === "function"
          ? [{ id: t.id, name: t.function.name, arguments: t.function.arguments }]
          : [],
      );
      return { content: msg?.content ?? "", toolCalls };
    }
    const chunks = await c.chat.completions.create({
      model: "gpt-test",
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
    });
    let content = "";
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    for await (const chunk of chunks) {
      const delta = chunk.choices[0]?.delta;
      content += delta?.content ?? "";
      for (const t of delta?.tool_calls ?? []) {
        let slot = toolCalls[t.index];
        if (slot === undefined) {
          slot = { id: "", name: "", arguments: "" };
          toolCalls[t.index] = slot;
        }
        slot.id += t.id ?? "";
        slot.name += t.function?.name ?? "";
        slot.arguments += t.function?.arguments ?? "";
      }
    }
    return { content, toolCalls };
  };

  const first = await turn();
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: first.toolCalls.map((t) => ({
      id: t.id,
      type: "function" as const,
      function: { name: t.name, arguments: t.arguments },
    })),
  });
  for (const t of first.toolCalls) {
    messages.push({
      role: "tool",
      tool_call_id: t.id,
      content: getWeather(JSON.parse(t.arguments)),
    });
  }
  const second = await turn();
  return { toolCalls: first.toolCalls, answer: second.content };
}

/**
 * A two-call Responses API agent: ask, run the requested tool, answer.
 *
 * @param c - The OpenAI client.
 * @param stream - Whether to stream both calls.
 * @param system - The instructions.
 * @returns The tool calls made and the final answer.
 */
async function runResponses(
  c: OpenAI,
  stream: boolean,
  system = "You are a weather assistant.",
): Promise<{ toolCalls: { call_id: string; name: string; arguments: string }[]; answer: string }> {
  const input: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: "What is the weather in Paris?" },
  ];
  const tools: OpenAI.Responses.Tool[] = [
    { type: "function", name: "get_weather", parameters: WEATHER_PARAMETERS, strict: true },
  ];
  const turn = async (): Promise<{
    text: string;
    output: OpenAI.Responses.ResponseOutputItem[];
  }> => {
    if (!stream) {
      const res = await c.responses.create({
        model: "gpt-test",
        instructions: system,
        input,
        tools,
      });
      return { text: res.output_text, output: res.output };
    }
    const events = await c.responses.create({
      model: "gpt-test",
      instructions: system,
      input,
      tools,
      stream: true,
    });
    let text = "";
    let output: OpenAI.Responses.ResponseOutputItem[] = [];
    for await (const event of events) {
      if (event.type === "response.output_text.delta") text += event.delta;
      if (event.type === "response.completed") output = event.response.output;
    }
    return { text, output };
  };

  const first = await turn();
  const toolCalls = first.output.flatMap((item) =>
    item.type === "function_call"
      ? [{ call_id: item.call_id, name: item.name, arguments: item.arguments }]
      : [],
  );
  for (const t of toolCalls) {
    input.push({ type: "function_call", ...t });
    input.push({
      type: "function_call_output",
      call_id: t.call_id,
      output: getWeather(JSON.parse(t.arguments)),
    });
  }
  const second = await turn();
  return { toolCalls, answer: second.text };
}

test.each([false, true])("openai chat completions (stream=%s) record -> replay", async (stream) => {
  const first = await replay(`oa-chat-${stream}`, () => runChat(client, stream), { dir });
  expect(fake.calls).toHaveLength(2);
  expect(first.toolCalls).toEqual([
    { id: "call_weather_1", name: "get_weather", arguments: '{"city":"Paris"}' },
  ]);
  expect(first.answer).toBe(ANSWER);

  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  await fake.close();
  const second = await replay(`oa-chat-${stream}`, () => runChat(client, stream), { dir });
  expect(second).toEqual(first);
});

test.each([false, true])("openai responses (stream=%s) record -> replay", async (stream) => {
  const first = await replay(`oa-resp-${stream}`, () => runResponses(client, stream), { dir });
  expect(fake.calls).toHaveLength(2);
  expect(first.toolCalls).toEqual([
    { call_id: "call_weather_1", name: "get_weather", arguments: '{"city":"Paris"}' },
  ]);
  expect(first.answer).toBe(ANSWER);

  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  await fake.close();
  const second = await replay(`oa-resp-${stream}`, () => runResponses(client, stream), { dir });
  expect(second).toEqual(first);
});

test("chat system prompt change -> step 1 of 2 with system diff", async () => {
  await replay("oa-chat-sys", () => runChat(client, false), { dir });
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  await fake.close();
  await expectChangeReport(
    replay("oa-chat-sys", () => runChat(client, false, "New system prompt"), { dir }),
    /changed at step 1 of 2[\s\S]*System prompt:[\s\S]*\+ New system prompt/,
  );
});

test("responses instructions change -> step 1 of 2 with system diff", async () => {
  await replay("oa-resp-sys", () => runResponses(client, true), { dir });
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  await fake.close();
  await expectChangeReport(
    replay("oa-resp-sys", () => runResponses(client, true, "New system prompt"), { dir }),
    /changed at step 1 of 2[\s\S]*System prompt:[\s\S]*\+ New system prompt/,
  );
});

test("a client constructed at module load is still intercepted", async () => {
  early.reply(toolThenText(WEATHER_CALL, ANSWER));
  const before = early.calls.length;
  const first = await replay("oa-early", () => runChat(earlyClient, false), { dir });
  expect(early.calls.length - before).toBe(2);

  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const second = await replay("oa-early", () => runChat(earlyClient, false), { dir });
  expect(early.calls.length - before).toBe(2);
  expect(second).toEqual(first);
});

test("transient 429 while recording is retried and not recorded; replay is one clean call", async () => {
  const flaky = await startFakeProvider({ failFirst: 1 });
  try {
    flaky.reply(toolThenText(WEATHER_CALL, ANSWER));
    configure({ providerHosts: [flaky.host] });
    const c = new OpenAI({ baseURL: `${flaky.baseURL}/v1`, apiKey: API_KEY, maxRetries: 2 });
    const first = await replay("oa-transient", () => runChat(c, false), { dir });
    expect(flaky.calls).toHaveLength(3);

    const rec = JSON.parse(readFileSync(join(dir, "oa-transient.json"), "utf8")) as Recording;
    const llm = rec.steps.filter((s) => s.type === "llm");
    expect(llm).toHaveLength(2);
    expect(llm.map((s) => s.response.status)).toEqual([200, 200]);

    vi.stubEnv("AGENT_RETRACE_MODE", "replay");
    await flaky.close();
    const started = performance.now();
    expect(await replay("oa-transient", () => runChat(c, false), { dir })).toEqual(first);
    expect(performance.now() - started).toBeLessThan(500);
  } finally {
    await flaky.close();
  }
});

test.each([false, true])(
  "gzip responses (stream=%s) are stored readable and replay",
  async (stream) => {
    const zipped = await startFakeProvider({ gzip: true });
    try {
      zipped.reply(toolThenText(WEATHER_CALL, ANSWER));
      configure({ providerHosts: [zipped.host] });
      const c = new OpenAI({ baseURL: `${zipped.baseURL}/v1`, apiKey: API_KEY, maxRetries: 2 });
      const first = await replay(`oa-gzip-${stream}`, () => runChat(c, stream), { dir });
      expect(first.answer).toBe(ANSWER);

      const text = readFileSync(join(dir, `oa-gzip-${stream}.json`), "utf8");
      expect(text).toContain('"call_weather_1"');
      expect(text).not.toMatch(/content-encoding/i);
      const rec = JSON.parse(text) as Recording;
      expect(rec.steps).toHaveLength(2);

      vi.stubEnv("AGENT_RETRACE_MODE", "replay");
      await zipped.close();
      expect(await replay(`oa-gzip-${stream}`, () => runChat(c, stream), { dir })).toEqual(first);
    } finally {
      await zipped.close();
    }
  },
);
