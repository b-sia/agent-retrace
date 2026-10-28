/**
 * Tests for rendering change reports.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { type ChangeReport, describeStep, renderChange } from "../../src/diff/render.js";
import type { LlmStep, RecordedRequest, Step, ToolStep } from "../../src/recording/format.js";
import {
  anthropicMessages,
  openaiChat,
  openaiResponses,
  orderSchema,
} from "./fixtures/requests.js";

const CWD = "/work/app";
const COMMAND = "AGENT_RETRACE_MODE=update npx vitest run test/a.test.ts";

/**
 * Wraps a request in an LLM step with a fixed response.
 *
 * @param request - The request.
 * @returns The step.
 */
function llm(request: RecordedRequest): LlmStep {
  return { type: "llm", request, response: { status: 200, headers: {}, body: {} } };
}

/**
 * Builds a tool step that returned nothing.
 *
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @returns The step.
 */
function tool(name: string, ...args: ToolStep["args"]): ToolStep {
  return { type: "tool", name, args, outcome: { type: "return" } };
}

/**
 * Builds a report for step 2 of 5.
 *
 * @param recorded - The recorded step or request.
 * @param live - The live step or request.
 * @param kind - The report kind.
 * @returns The report.
 */
function report(
  recorded: Step | RecordedRequest | undefined,
  live: Step | RecordedRequest | undefined,
  kind: ChangeReport["kind"] = "changed",
): ChangeReport {
  const asStep = (s: Step | RecordedRequest | undefined) =>
    s === undefined || "type" in s ? s : llm(s);
  return {
    recordingName: "refund",
    recordingPath: join(CWD, "test/__recordings__/refund.json"),
    kind,
    stepNumber: 2,
    totalSteps: 5,
    recorded: asStep(recorded),
    live: asStep(live),
    command: COMMAND,
  };
}

/**
 * Renders a report without color, relative to `CWD`.
 *
 * @param r - The report.
 * @returns The text.
 */
function render(r: ChangeReport): string {
  return renderChange(r, { color: false, cwd: CWD });
}

const FOOTER = [
  "Recording: test/__recordings__/refund.json",
  "To accept this change and re-record from step 2, run:",
  `  ${COMMAND}`,
].join("\n");

test("describeStep", () => {
  expect(describeStep(llm(openaiChat()))).toBe(
    "LLM call (POST api.openai.com/v1/chat/completions)",
  );
  expect(describeStep(tool("search"))).toBe("tool `search`");
});

test("system prompt change renders a line diff, not JSON", () => {
  const out = render(
    report(openaiChat(), openaiChat({ system: "You are a support agent.\nAlways apologize." })),
  );
  expect(out).toBe(
    [
      'agent-retrace: recording "refund" no longer matches.',
      "Your agent changed at step 2 of 5: LLM call (POST api.openai.com/v1/chat/completions)",
      "",
      "System prompt:",
      "  You are a support agent.",
      "+ Always apologize.",
      "",
      FOOTER,
    ].join("\n"),
  );
  expect(out).not.toContain('"messages"');
});

test("system prompt diff keeps at most 3 lines of context", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const changed = lines.map((l) => (l === "line 10" ? "line ten" : l));
  const out = render(
    report(
      anthropicMessages({ system: lines.join("\n") }),
      anthropicMessages({ system: changed.join("\n") }),
    ),
  );
  expect(out).toContain(
    [
      "System prompt:",
      "  ...",
      "  line 7",
      "  line 8",
      "  line 9",
      "- line 10",
      "+ line ten",
      "  line 11",
      "  line 12",
      "  line 13",
      "  ...",
      "",
    ].join("\n"),
  );
});

test("a trailing newline change is visible", () => {
  const out = render(report(openaiChat({ system: "a" }), openaiChat({ system: "a\n" })));
  expect(out).toContain("System prompt:\n  a\n+ \n\n");
});

test("message changes show added and removed lines with unchanged counts", () => {
  const out = render(
    report(openaiResponses(), openaiResponses({ user: "My order arrived damaged" })),
  );
  expect(out).toContain(
    ["Messages:", "- user: My order arrived broken", "+ user: My order arrived damaged", ""].join(
      "\n",
    ),
  );
  const longer = {
    ...openaiChat(),
    body: {
      ...(openaiChat().body as object),
      messages: [
        { role: "system", content: "You are a support agent." },
        { role: "user", content: "My order arrived broken" },
        { role: "assistant", content: "Sorry!" },
        { role: "user", content: "Refund me" },
      ],
    },
  };
  expect(render(report(openaiChat(), longer))).toContain(
    ["Messages:", "  (1 unchanged)", "+ assistant: Sorry!", "+ user: Refund me", ""].join("\n"),
  );
});

test("tool added and schema changed", () => {
  const changedSchema = {
    ...(orderSchema as object),
    properties: { orderId: { type: "number" } },
  };
  const out = render(
    report(
      anthropicMessages(),
      anthropicMessages({
        tools: [
          { name: "issue_refund", input_schema: { type: "object" } },
          { name: "lookup_order", input_schema: changedSchema },
        ],
      }),
    ),
  );
  expect(out).toContain(
    [
      "Tools:",
      "+ added issue_refund",
      "~ changed lookup_order (schema)",
      "      {",
      '        "type": "object",',
      '        "properties": {',
      '          "orderId": {',
      '    -       "type": "string"',
      '    +       "type": "number"',
      "          }",
      "        },",
      '        "required": [',
      "      ...",
      "",
    ].join("\n"),
  );
});

test("tool removed", () =>
  expect(render(report(openaiChat(), openaiChat({ tools: [] })))).toContain(
    "Tools:\n- removed lookup_order\n",
  ));

test("param change", () => {
  const out = render(report(openaiChat(), openaiChat({ params: { temperature: 0.7, top_p: 1 } })));
  expect(out).toContain("Params:\n~ temperature: 0 -> 0.7\n+ top_p: 1\n");
  expect(render(report(openaiChat({ params: { seed: 1 } }), openaiChat({ params: {} })))).toContain(
    "Params:\n- seed: 1\n",
  );
});

test("model, endpoint and header changes", () => {
  const a = anthropicMessages();
  const b = anthropicMessages({ model: "claude-haiku-5-5" });
  const out = render(
    report(a, {
      ...b,
      url: "https://api.anthropic.com/v1/messages?beta=true",
      headers: { ...b.headers, "anthropic-beta": "x" },
    }),
  );
  expect(out).toContain(
    [
      "Endpoint: POST api.anthropic.com/v1/messages -> POST api.anthropic.com/v1/messages?beta=true",
      "",
      "Headers:",
      "+ anthropic-beta: x",
      "",
      "Model: claude-sonnet-5-5 -> claude-haiku-5-5",
      "",
    ].join("\n"),
  );
});

test("a change the semantic view cannot see falls back to the raw body", () => {
  const image = (url: string) =>
    llm({
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] },
    });
  const out = render(report(image("a.png"), image("b.png")));
  expect(out).toContain("Request body:\n");
  expect(out).toContain('-             "url": "a.png"\n+             "url": "b.png"');
});

test("unknown APIs show a diff of the bodies", () => {
  const req = (input: string): RecordedRequest => ({
    method: "POST",
    url: "https://example.com/v1/embeddings",
    headers: {},
    body: { input, model: "e" },
  });
  expect(render(report(req("a"), req("b")))).toContain(
    'Request body:\n  {\n-   "input": "a",\n+   "input": "b",\n    "model": "e"\n  }\n',
  );
});

test("tool step changes", () => {
  expect(render(report(tool("search", { q: "a" }), tool("search", { q: "b" })))).toContain(
    ["Arguments:", "  [", "    {", '-     "q": "a"', '+     "q": "b"', "    }", "  ]", ""].join(
      "\n",
    ),
  );
  expect(render(report(tool("search"), tool("find")))).toContain("Tool: search -> find\n");
});

test("step type change", () =>
  expect(render(report(llm(openaiChat()), tool("search")))).toContain(
    "Step type: LLM call (POST api.openai.com/v1/chat/completions) -> tool `search`\n",
  ));

test("extra and missing headers", () => {
  expect(render(report(undefined, tool("search"), "extra"))).toBe(
    [
      'agent-retrace: recording "refund" no longer matches.',
      "Your agent made more calls than recorded: step 2 is new (recording has 5 steps): tool `search`",
      "",
      FOOTER,
    ].join("\n"),
  );
  expect(render(report(llm(openaiChat()), undefined, "missing"))).toBe(
    [
      'agent-retrace: recording "refund" no longer matches.',
      "Your agent made fewer calls than recorded: step 2 of 5 was never made: LLM call (POST api.openai.com/v1/chat/completions)",
      "",
      FOOTER,
    ].join("\n"),
  );
});

test("footer has command", () =>
  expect(render(report(tool("a"), tool("b")))).toContain(
    "  AGENT_RETRACE_MODE=update npx vitest run test/a.test.ts",
  ));

test("a recording path outside cwd stays absolute", () =>
  expect(
    renderChange(
      { ...report(tool("a"), tool("b")), recordingPath: "/elsewhere/r.json" },
      {
        color: false,
        cwd: CWD,
      },
    ),
  ).toContain("Recording: /elsewhere/r.json\n"));

test("color is applied only when asked", () => {
  const r = report(openaiChat(), openaiChat({ params: { temperature: 1 } }));
  expect(renderChange(r, { color: true, cwd: CWD })).toContain("\x1b[");
  expect(renderChange(r, { color: false, cwd: CWD })).not.toContain("\x1b[");
});
