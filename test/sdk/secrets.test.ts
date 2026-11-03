/**
 * Secrets never reach a recording: records with every SDK in the suite, with
 * the provider setting cookies and the API key pasted into the prompt, then
 * scans every file written.
 */
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import Anthropic from "@anthropic-ai/sdk";
import { generateText, isStepCount, jsonSchema, type LanguageModel, streamText, tool } from "ai";
import OpenAI from "openai";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { resetConfig } from "../../src/config.js";
import { configure, recordTool, replay } from "../../src/index.js";
import { type FakeProvider, startFakeProvider, toolThenText } from "../support/fake-provider.js";

const API_KEY = "sk-test-SECRET123456";
const PROMPT = `My key is ${API_KEY}. What is the weather in Paris?`;

let fake: FakeProvider;
let dir: string;

beforeAll(async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "auto");
  fake = await startFakeProvider({ setCookie: true });
  fake.reply(
    toolThenText({ id: "call_1", name: "get_weather", args: { city: "Paris" } }, "Sunny."),
  );
  configure({ providerHosts: [fake.host] });
  dir = await mkdtemp(join(tmpdir(), "agent-retrace-secrets-"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetConfig();
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

/** Every SDK path, each making at least one call with the key in the prompt. */
const AGENTS: Record<string, () => Promise<unknown>> = {
  "openai-chat": async () => {
    const c = new OpenAI({ baseURL: `${fake.baseURL}/v1`, apiKey: API_KEY, maxRetries: 2 });
    await c.chat.completions.create({
      model: "gpt-test",
      messages: [{ role: "user", content: PROMPT }],
    });
    const stream = await c.chat.completions.create({
      model: "gpt-test",
      messages: [{ role: "user", content: PROMPT }],
      stream: true,
    });
    for await (const _ of stream);
  },
  "openai-responses": async () => {
    const c = new OpenAI({ baseURL: `${fake.baseURL}/v1`, apiKey: API_KEY, maxRetries: 2 });
    await c.responses.create({ model: "gpt-test", input: PROMPT });
    for await (const _ of await c.responses.create({
      model: "gpt-test",
      input: PROMPT,
      stream: true,
    }));
  },
  anthropic: async () => {
    const c = new Anthropic({ baseURL: fake.baseURL, apiKey: API_KEY, maxRetries: 2 });
    const params = {
      model: "claude-test",
      max_tokens: 64,
      messages: [{ role: "user" as const, content: PROMPT }],
    };
    await c.messages.create(params);
    await c.messages.stream(params).finalMessage();
  },
  ...Object.fromEntries(
    Object.entries({
      "vercel-openai": () =>
        createOpenAI({ baseURL: `${fake.baseURL}/v1`, apiKey: API_KEY })("gpt-test"),
      "vercel-openai-chat": () =>
        createOpenAI({ baseURL: `${fake.baseURL}/v1`, apiKey: API_KEY }).chat("gpt-test"),
      "vercel-anthropic": () =>
        createAnthropic({ baseURL: `${fake.baseURL}/v1`, apiKey: API_KEY })("claude-test"),
    }).map(([name, model]) => [name, () => vercelAgent(model())]),
  ),
};

/**
 * Runs `generateText` and `streamText` with a recorded tool.
 *
 * @param model - The language model.
 */
async function vercelAgent(model: LanguageModel): Promise<void> {
  const args = {
    model,
    prompt: PROMPT,
    // Set explicitly so the AI SDK does not warn that the fake model is
    // unknown and pick a limit for it.
    maxOutputTokens: 1024,
    stopWhen: isStepCount(3),
    tools: {
      get_weather: tool({
        inputSchema: jsonSchema<{ city: string }>({
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        }),
        execute: recordTool(
          "get_weather",
          async ({ city }: { city: string }) => `sunny in ${city}`,
        ),
      }),
    },
  };
  await generateText(args);
  for await (const _ of streamText({ ...args, onError: () => {} }).textStream);
}

test.each(Object.entries(AGENTS))("records with %s", async (name, agent) => {
  const before = fake.calls.length;
  await replay(`secrets-${name}`, agent, { dir });
  expect(fake.calls.length).toBeGreaterThan(before);
  expect(fake.calls.at(-1)?.headers).toSatisfy(
    (h: Record<string, string>) => h.authorization !== undefined || h["x-api-key"] !== undefined,
  );
});

test("no recording contains the API key, auth headers or cookies", () => {
  const files = readdirSync(dir);
  expect(files).toHaveLength(Object.keys(AGENTS).length);
  const text = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  expect(text).toContain("REDACTED");
  for (const pattern of [/sk-test-SECRET123456/, /authorization/i, /x-api-key/i, /set-cookie/i]) {
    expect(text).not.toMatch(pattern);
  }
});
