/**
 * SDK compatibility: the Vercel AI SDK (`generateText`, `streamText`) with the
 * `@ai-sdk/openai` (Responses and Chat) and `@ai-sdk/anthropic` providers,
 * including a tool whose `execute` is wrapped with `recordTool`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, jsonSchema, type LanguageModel, streamText, tool } from "ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetConfig } from "../../src/config.js";
import { configure, recordTool, replay } from "../../src/index.js";
import { expectChangeReport } from "../support/change-error.js";
import { type FakeProvider, startFakeProvider, toolThenText } from "../support/fake-provider.js";

const API_KEY = "sk-test-SECRET123456";
const ANSWER = "It is sunny in Paris.";

let fake: FakeProvider;
let dir: string;

beforeEach(async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
  fake = await startFakeProvider();
  configure({ providerHosts: [fake.host] });
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-vercel-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetConfig();
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

/** Provider/model combinations under test. */
const MODELS: Record<string, (f: FakeProvider) => LanguageModel> = {
  "openai-responses": (f) =>
    createOpenAI({ baseURL: `${f.baseURL}/v1`, apiKey: API_KEY }).responses("gpt-test"),
  "openai-chat": (f) =>
    createOpenAI({ baseURL: `${f.baseURL}/v1`, apiKey: API_KEY }).chat("gpt-test"),
  anthropic: (f) => createAnthropic({ baseURL: `${f.baseURL}/v1`, apiKey: API_KEY })("claude-test"),
};

const CASES = Object.entries(MODELS).flatMap(([provider, model]) =>
  (["generateText", "streamText"] as const).map((fn) => ({ provider, fn, model })),
);

/**
 * A weather agent on the Vercel AI SDK. `execute` is a recorded tool.
 *
 * @param model - The language model.
 * @param fn - Which AI SDK entry point to use.
 * @param execute - The tool implementation.
 * @param system - The system prompt.
 * @returns The final text and the tool results seen.
 */
async function runAgent(
  model: LanguageModel,
  fn: "generateText" | "streamText",
  execute: (input: { city: string }) => Promise<string>,
  system = "You are a weather assistant.",
): Promise<{ text: string; toolResults: unknown[] }> {
  const args = {
    model,
    system,
    prompt: "What is the weather in Paris?",
    maxRetries: 2,
    // Set explicitly so the AI SDK does not warn that the fake model is
    // unknown and pick a limit for it.
    maxOutputTokens: 1024,
    stopWhen: isStepCount(3),
    tools: {
      get_weather: tool({
        description: "Current weather for a city",
        inputSchema: jsonSchema<{ city: string }>({
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        }),
        execute,
      }),
    },
  };
  if (fn === "generateText") {
    const res = await generateText(args);
    return {
      text: res.text,
      toolResults: res.steps.flatMap((s) => s.toolResults.map((r) => r.output)),
    };
  }
  const res = streamText({ ...args, onError: () => {} });
  let text = "";
  for await (const delta of res.textStream) text += delta;
  const steps = await res.steps;
  return { text, toolResults: steps.flatMap((s) => s.toolResults.map((r) => r.output)) };
}

test.each(CASES)(
  "vercel ai $fn with $provider record -> replay, tool replayed",
  async ({ provider, fn, model }) => {
    fake.reply(
      toolThenText({ id: "call_weather_1", name: "get_weather", args: { city: "Paris" } }, ANSWER),
    );
    const impl = vi.fn(async (input: { city: string }) => `sunny, 21C in ${input.city}`);
    const execute = recordTool("get_weather", impl);
    const name = `vc-${provider}-${fn}`;

    const first = await replay(name, () => runAgent(model(fake), fn, execute), { dir });
    expect(first).toEqual({ text: ANSWER, toolResults: ["sunny, 21C in Paris"] });
    expect(fake.calls).toHaveLength(2);
    expect(impl).toHaveBeenCalledTimes(1);

    vi.stubEnv("AGENT_RETRACE_MODE", "replay");
    await fake.close();
    const second = await replay(name, () => runAgent(model(fake), fn, execute), {
      dir,
    });
    expect(second).toEqual(first);
    expect(impl).toHaveBeenCalledTimes(1);
  },
);

test.each(Object.entries(MODELS))(
  "vercel ai system prompt change with %s -> step 1",
  async (_provider, model) => {
    fake.reply(
      toolThenText({ id: "call_weather_1", name: "get_weather", args: { city: "Paris" } }, ANSWER),
    );
    const execute = recordTool(
      "get_weather",
      async (input: { city: string }) => `sunny in ${input.city}`,
    );
    await replay("vc-sys", () => runAgent(model(fake), "generateText", execute), {
      dir,
    });

    vi.stubEnv("AGENT_RETRACE_MODE", "replay");
    await fake.close();
    await expectChangeReport(
      replay("vc-sys", () => runAgent(model(fake), "generateText", execute, "New system prompt"), {
        dir,
      }),
      /changed at step 1 of 3[\s\S]*System prompt:[\s\S]*\+ New system prompt/,
    );
  },
);
