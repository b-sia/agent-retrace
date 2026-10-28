/**
 * Tests for turning provider requests into semantic requests.
 */
import { expect, test } from "vitest";
import { toSemantic } from "../../src/diff/semantic.js";
import type { RecordedRequest } from "../../src/recording/format.js";
import {
  anthropicMessages,
  openaiChat,
  openaiResponses,
  orderSchema,
} from "./fixtures/requests.js";

/**
 * Builds a POST request with a JSON body.
 *
 * @param url - Request URL.
 * @param body - Request body.
 * @param headers - Request headers.
 * @returns The request.
 */
function post(url: string, body: RecordedRequest["body"], headers = {}): RecordedRequest {
  return { method: "POST", url, headers, body };
}

test.each([
  ["openai-chat", openaiChat()],
  ["openai-responses", openaiResponses()],
  ["anthropic-messages", anthropicMessages()],
])("%s: system, messages, tools extracted", (api, req) => {
  const s = toSemantic(req);
  expect(s.api).toBe(api);
  expect(s.system).toBe("You are a support agent.");
  expect(s.messages[0]).toBe("user: My order arrived broken");
  expect([...s.tools.keys()]).toEqual(["lookup_order"]);
  expect(s.tools.get("lookup_order")).toEqual(orderSchema);
  expect(s.params).toEqual({ temperature: 0 });
});

test("endpoint and model", () => {
  const s = toSemantic(openaiChat());
  expect(s.endpoint).toBe("POST api.openai.com/v1/chat/completions");
  expect(s.model).toBe("gpt-5");
});

test("endpoint keeps the query string and a non-default port", () =>
  expect(
    toSemantic(
      post("http://localhost:8080/openai/deployments/d/chat/completions?api-version=1", {}),
    ).endpoint,
  ).toBe("POST localhost:8080/openai/deployments/d/chat/completions?api-version=1"));

test("openai-chat: tool calls, tool results, developer messages and parts", () => {
  const s = toSemantic(
    post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-5",
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "system", content: [{ type: "text", text: "Be kind." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Look at" },
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "text", text: "this\nphoto" },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{ "q": "x" }' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "found it" },
        { role: "assistant", content: "Done." },
      ],
    }),
  );
  expect(s.system).toBe("Be brief.\nBe kind.");
  expect(s.messages).toEqual([
    "user: Look at [image_url] this\\nphoto",
    'assistant -> tool_call search({"q":"x"})',
    "tool_result(call_1): found it",
    "assistant: Done.",
  ]);
});

test("openai-chat: tool call arguments that are not JSON are shown as sent", () =>
  expect(
    toSemantic(
      post("https://api.openai.com/v1/chat/completions", {
        messages: [
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [{ function: { name: "search", arguments: "{bad" } }],
          },
        ],
      }),
    ).messages,
  ).toEqual(["assistant: Let me check.", "assistant -> tool_call search({bad)"]));

test("openai-responses: string input is one user line", () => {
  const s = toSemantic(post("https://api.openai.com/v1/responses", { input: "hi\nthere" }));
  expect(s.api).toBe("openai-responses");
  expect(s.system).toBe("");
  expect(s.messages).toEqual(["user: hi\\nthere"]);
});

test("openai-responses: items, function calls and outputs", () => {
  const s = toSemantic(
    post("https://api.openai.com/v1/responses", {
      instructions: "Be kind.",
      input: [
        { role: "developer", content: "Be brief." },
        { type: "message", role: "user", content: "Find x" },
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", call_id: "c1", name: "search", arguments: '{"q":"x"}' },
        { type: "function_call_output", call_id: "c1", output: "found" },
        { role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      ],
      tools: [{ type: "web_search" }],
    }),
  );
  expect(s.system).toBe("Be kind.\nBe brief.");
  expect(s.messages).toEqual([
    "user: Find x",
    "[reasoning]",
    'assistant -> tool_call search({"q":"x"})',
    "tool_result(c1): found",
    "assistant: Done.",
  ]);
  expect(s.tools.get("web_search")).toEqual({ type: "web_search" });
});

test("anthropic: string system, tool use and tool result blocks", () => {
  const s = toSemantic(
    post("https://api.anthropic.com/v1/messages", {
      system: "Be kind.",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [{ type: "text", text: "found" }],
            },
          ],
        },
      ],
      max_tokens: 100,
    }),
  );
  expect(s.system).toBe("Be kind.");
  expect(s.messages).toEqual([
    "assistant: Checking.",
    'assistant -> tool_call search({"q":"x"})',
    "tool_result(tu_1): found",
  ]);
  expect(s.params).toEqual({ max_tokens: 100 });
});

test("anthropic is detected by the version header behind a gateway", () =>
  expect(
    toSemantic(post("https://gw.example.com/v1/messages", {}, { "anthropic-version": "1" })).api,
  ).toBe("anthropic-messages"));

test("/messages on another host without the header is unknown", () =>
  expect(toSemantic(post("https://gw.example.com/v1/messages", {})).api).toBe("unknown"));

test("unknown API reads only the model", () => {
  const s = toSemantic(post("https://example.com/v1/embeddings", { model: "e", input: "x" }));
  expect(s.api).toBe("unknown");
  expect(s.model).toBe("e");
  expect(s.messages).toEqual([]);
  expect(s.tools.size).toBe(0);
  expect(s.params).toEqual({});
});

test.each([
  [
    "a text body",
    { method: "POST", url: "https://api.openai.com/v1/responses", headers: {}, text: "x" },
  ],
  ["an array body", post("https://api.openai.com/v1/chat/completions", [1, 2])],
  [
    "wrong field types",
    post("https://api.openai.com/v1/chat/completions", { messages: "x", tools: 1, model: 3 }),
  ],
  [
    "junk messages",
    post("https://api.anthropic.com/v1/messages", {
      messages: [null, 1, { content: 2 }],
      system: 5,
    }),
  ],
  ["an unparseable URL", { method: "GET", url: "not a url", headers: {} }],
] as [string, RecordedRequest][])("does not throw on %s", (_, req) => {
  expect(() => toSemantic(req)).not.toThrow();
});

test.each([
  [
    "openai-chat",
    post("https://api.openai.com/v1/chat/completions", {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ function: { name: "f", arguments: '{"b":1,"a":{"d":2,"c":3}}' } }],
        },
      ],
    }),
  ],
  [
    "anthropic-messages",
    post("https://api.anthropic.com/v1/messages", {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "f", input: { b: 1, a: { d: 2, c: 3 } } }],
        },
      ],
    }),
  ],
])("%s: tool call arguments are shown with sorted keys", (_api, req) =>
  expect(toSemantic(req).messages).toEqual(['assistant -> tool_call f({"a":{"c":3,"d":2},"b":1})']),
);

test("anthropic: system blocks are joined with newlines", () =>
  expect(
    toSemantic(
      post("https://api.anthropic.com/v1/messages", {
        system: [
          { type: "text", text: "Line A" },
          { type: "text", text: "Line B", cache_control: { type: "ephemeral" } },
        ],
      }),
    ).system,
  ).toBe("Line A\nLine B"));
