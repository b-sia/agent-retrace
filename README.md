# agent-retrace

Record your agent's LLM and tool calls once, replay them offline in every test run, and when the agent changes, see exactly which step changed and how: "Your agent changed at step 1 of 6", with a readable diff.

![Demo: the example agent's tests pass from recordings, a system prompt edit is reported as a change at step 1 of 6 with a diff](docs/demo/demo.gif)

- **Offline and free in CI.** Provider calls are served from recordings committed next to your tests. In CI, any call that would reach a provider fails the test instead.
- **Changes, not "cassette mismatch".** When a prompt, a tool or a parameter changes, agent-retrace replays the steps that still match, stops at the first one that does not, and shows what the agent now sends differently.
- **Re-record from the changed step only.** Update mode keeps the unchanged steps and calls the real API only from the change onward.
- **No changes to your agent code.** It works at the HTTP level, so the official OpenAI and Anthropic SDKs and the Vercel AI SDK work unchanged, streaming included.

## Quick start

```sh
npm i -D agent-retrace
```

Wrap the body of a test in `replay()`. The name is the recording's file name.

```ts
import { replay } from "agent-retrace";
import { expect, test } from "vitest";
import { runSupportAgent } from "./agent.js";

test("support agent refunds a damaged order", async () => {
  await replay("refund-damaged-order", async () => {
    const result = await runSupportAgent("My order arrived broken");
    expect(result.action).toBe("refund");
  });
});
```

Run it once with your API key set:

```sh
ANTHROPIC_API_KEY=sk-ant-... npx vitest run
```

The first run calls the real API and writes `__recordings__/refund-damaged-order.json` next to the test file. Commit that folder:

```sh
git add __recordings__
```

Every later run, locally or in CI, replays the recording: no network, no API key, no cost. `replay()` returns what its function returns, so you can also assert outside it.

A complete, runnable example lives in [`examples/support-agent`](examples/support-agent): a customer support agent with three tools, its tests and its committed recordings.

## What a change looks like

Add one line to the example agent's system prompt and run its tests. This is the real output:

```text
ChangeDetectedError: agent-retrace: recording "refund-damaged-order" no longer matches.
Your agent changed at step 1 of 6: LLM call (POST api.anthropic.com/v1/messages)

System prompt:
  ...
  Refund damaged or broken items with the issue_refund tool.
  Choose exactly one action: refund, replace, escalate (a human must decide) or answer (you only gave information).
  Keep the reply short and friendly.
+ Always offer a discount code.

Recording: examples/support-agent/__recordings__/refund-damaged-order.json
To accept this change and re-record from step 1, run:
  AGENT_RETRACE_MODE=update npx vitest run examples/support-agent/agent.test.ts
```

The report names the first step that changed, its position and type (an LLM call or a tool), and a diff of what changed, by meaning rather than raw JSON: a line diff of the system prompt, messages added or removed, tools added, removed or with a changed schema, and model or parameter changes. An agent that makes more calls than recorded, or fewer, is reported at the step where it diverged.

The test fails with `ChangeDetectedError` even if your agent catches the SDK error and carries on with a fallback answer, so a change can never pass silently.

## Modes

Set the mode with the `AGENT_RETRACE_MODE` environment variable.

| Mode     | Default when             | Behavior                                                                                                                                                                                                                          |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay` | `CI` env var is set      | Replay only. Any network call to a provider host, missing recording or change fails the test. Never sends a request to a provider host. Non-provider traffic (localhost, test databases, unwrapped tools) is not blocked.         |
| `auto`   | locally                  | Replay if a recording exists. If none exists, record it live. A change fails the test with the diff (it does not re-record).                                                                                                      |
| `update` | only when set explicitly | Replay the unchanged steps, then go live from the first changed step and re-record everything after it. Steps after the change in the old recording are discarded. Tools wrapped with `recordTool` also run live from that point. |

Recordings change only when you ask for it, the same way snapshot tests work.

## Recording tool calls: `recordTool`

Provider calls are recorded automatically. Your agent's own tools are recorded when you wrap them:

```ts
import { recordTool } from "agent-retrace";

export const lookupOrder = recordTool("lookup_order", async (orderId: string) => {
  return db.orders.find(orderId);
});
```

Inside `replay()`, a replayed call returns the recorded result (or throws the recorded error) without running the tool, so tests need no database, no tool credentials and cause no side effects. A tool call matches on its name and arguments. Outside `replay()`, the wrapper just calls the tool. Unwrapped tools always run for real.

Things to know:

- **The wrapper is always async**, even when the tool is not: `recordTool("add", (a, b) => a + b)` returns a function that returns a `Promise`.
- Results are stored as JSON. Inside `replay()` the caller gets the stored copy whether the tool ran or not, so a recording run behaves exactly like its replays: a `Date` comes back as its ISO string, a class instance as a plain object.
- Errors are stored by name, message, primitive fields (`code`, `status`) and cause. Built-in classes such as `TypeError` keep their class; other errors come back as a plain `Error` with the original `name`.
- To leave an argument out of matching and the recording (a logger, a client handle), pick the ones that count: `recordTool("search", searchImpl, { args: (query, _client) => [query] })`. The tool still receives all of its arguments.
- **Vercel AI SDK tools:** `execute` is called as `execute(input, options)`, and `options` carries the conversation so far (`messages`). Wrapped as is, every tool step stores the whole conversation and matches on it. Keep only the input: `execute: recordTool("get_weather", getWeather, { args: (input) => [input] })`.

## Configuration: `configure()`

Call `configure()` once, for example in a Vitest setup file.

```ts
import { configure } from "agent-retrace";

configure({
  providerHosts: ["my-gateway.example.com", "127.0.0.1:4010"],
  ignore: ["metadata", "messages.*.cache_control"],
  redact: [/cust_[a-z0-9]+/g, (value) => value.replaceAll("alice@example.com", "<email>")],
});
```

### Provider hosts

Calls to `api.openai.com` and `api.anthropic.com` are recorded and replayed by default. Hosts you add are treated exactly the same; entries are `host` or `host:port`, with no scheme or path. A host without a port matches it on any port.

> [!IMPORTANT]
> **If your client uses a custom `baseURL`** (Azure OpenAI, a corporate proxy, an LLM gateway, a local fake), **add its host to `providerHosts`.** Otherwise its calls are neither recorded nor replayed, and in CI they are not blocked: they go to the network like any other traffic.

### Redaction

API keys and auth headers (`authorization`, `x-api-key`, cookies and similar) are always stripped, and any API key from your environment is scrubbed wherever it appears. `redact` adds your own rules: a `RegExp` whose matches are replaced, or a function from a string to its redacted form. Rules apply to every string in provider requests and responses and in tool arguments, results and errors, before anything is written to disk.

Redaction also applies to matching: the live request is redacted the same way before it is compared with the recording, so a redacted value that differs between runs does not count as a change.

### Ignored fields

Some request fields vary from run to run without meaning anything, such as a user ID in `metadata` or cache hints. `ignore` takes request body paths that are left out of matching: dot-separated keys, with `*` for any array index or key, e.g. `messages.*.cache_control`. Headers need no rules: only `anthropic-version`, `anthropic-beta` and `openai-beta` are stored and matched, so request IDs, SDK version headers and the like never count as a change.

## Blocking provider calls outside `replay()`

Importing `agent-retrace` installs its interceptor. Add it as a Vitest setup file to cover tests that never call `replay()`:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["agent-retrace"],
  },
});
```

In `replay` mode (the default in CI), a provider call made outside `replay()` then fails with `ProviderCallBlockedError` instead of reaching the network. In the other modes such calls pass through, unrecorded.

## `node:test`

`replay()` works the same under Node's built-in test runner:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { replay } from "agent-retrace";
import { runSupportAgent } from "./agent.js";

test("support agent refunds a damaged order", async () => {
  const result = await replay("refund-damaged-order", () =>
    runSupportAgent("My order arrived broken"),
  );
  assert.equal(result.action, "refund");
});
```

```sh
node --test
```

Recordings go to `__recordings__/` next to the file that calls `replay()`. Pass `{ dir }` as the third argument to put them elsewhere. Concurrent tests each get their own recording: sessions are tracked with `AsyncLocalStorage`, not global state.

## CLI

`agent-retrace inspect <file>` prints a recording as a timeline:

```text
$ npx agent-retrace inspect examples/support-agent/__recordings__/refund-damaged-order.json
refund-damaged-order  (6 steps, format v1)

 1  LLM   POST api.anthropic.com/v1/messages  model=claude-opus-5-5
        > user: My order A1 arrived broken
        < assistant -> tool_call lookup_order({"orderId":"A1"})
        < assistant -> tool_call search_policies({"query":"damaged or broken item refund"})
 2  tool  lookup_order({"orderId":"A1"})
        < {"status":"delivered","deliveredOn":"2026-10-30","id":"A1","item":"Ceramic coffee mug","totalCent...
 3  tool  search_policies({"query":"damaged or broken item refund"})
        < [{"text":"If an item arrives damaged or broken, refund it in full. The customer does not need to ...
 4  LLM   POST api.anthropic.com/v1/messages  model=claude-opus-5-5
        > tool_result(toolu_01LVnzWvUVswpJU6j8qXgsW3): [{"text":"If an item arrives damaged or broken, refu...
        < assistant -> tool_call issue_refund({"orderId":"A1","reason":"Item arrived broken (ceramic coffee...
 5  tool  issue_refund({"orderId":"A1","reason":"Item arrived broken (ceramic coffee mug)"})
        < {"amountCents":1800,"orderId":"A1","reason":"Item arrived broken (ceramic coffee mug)","refundId"...
 6  LLM   POST api.anthropic.com/v1/messages  model=claude-opus-5-5
        > tool_result(toolu_01FLaRYYmM4jEFeZnPuD7Z7m): {"amountCents":1800,"orderId":"A1","reason":"Item ar...
        < assistant: {"action":"refund","reply":"I'm sorry your ceramic coffee mug arrived broken! I've ref...
```

Options: `--color` and `--no-color` (it also honors `NO_COLOR` and `FORCE_COLOR`). That is the whole CLI: recording, replaying and updating happen through your test runner.

## Recording format

One pretty-printed JSON file per recording, with stable key order, so it reads and diffs well in code review:

```json
{
  "formatVersion": 1,
  "name": "where-is-my-order",
  "steps": [
    {
      "type": "llm",
      "request": {
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "headers": { "anthropic-version": "2026-10-21" },
        "body": { "messages": ["..."], "model": "claude-opus-5-5", "system": "..." }
      },
      "response": {
        "status": 200,
        "headers": { "content-type": "application/json" },
        "body": { "...": "..." }
      }
    },
    {
      "name": "lookup_order",
      "type": "tool",
      "args": [{ "orderId": "B2" }],
      "outcome": {
        "type": "return",
        "value": { "status": "shipped", "carrier": "UPS", "expectedOn": "2026-11-05", "id": "B2" }
      }
    }
  ]
}
```

- A step is an LLM call (`request` and `response`) or a tool call (`name`, `args` and an `outcome` that is a `return` value or a `throw`n error).
- JSON bodies are stored as JSON. Streamed (SSE) responses are stored as a readable list of `events`, each with its `event` name and parsed `data`, and replayed as a stream so the SDK behaves as it did live.
- Compressed responses (gzip, br) are stored decoded and replayed without `content-encoding`.
- Transient errors (408, 409, 429, 5xx) are not recorded: the SDK's successful retry is, so a replay is one clean call with no retry delay.
- `formatVersion` lets the format evolve; a file with an unknown version fails with a clear error.

## Limitations

- **Fetch-based clients only.** Interception wraps Node's global undici dispatcher, which `fetch` uses. The OpenAI, Anthropic and Vercel AI SDKs use `fetch`. A provider call made through `node:http` or `node:https` (axios, older clients) inside `replay()` or in `replay` mode throws `ProviderCallBlockedError` rather than going unrecorded. Outside `replay()` in the other modes it goes through, unrecorded.
- **A client given its own undici dispatcher bypasses interception**, e.g. `fetchOptions: { dispatcher: new Agent() }`. Replacing the global dispatcher is fine: `replay()` installs itself on top of whatever is there (msw, nock, a `ProxyAgent`).
- **No clock or random freezing.** If your agent puts the current time or a random ID into a prompt, that request changes on every run. Add the field to `ignore`, or freeze it yourself (e.g. `vi.useFakeTimers()`).
- **The full request URL, port included, is part of matching**, so a local fake provider needs a stable origin. Either listen on a fixed port and configure it (`providerHosts: ["127.0.0.1:<port>"]`), or use a fixed hostname routed to a random-port server through an undici `Agent` with a custom `connect` (see [`test/node-test/replay.test.mjs`](test/node-test/replay.test.mjs)). A server on `listen(0)` reached by its real address produces recordings that stop matching on the next run.
- Node.js 22 or newer, ESM. Deno, Bun and browsers are not tested.

## Comparison

There are many small record-and-replay tools for LLM tests. agent-retrace's focus is what happens when a recording goes stale: the first changed step, its position, a readable diff, and re-recording from that step only. Other tools are ahead in other ways, and the table says where.

Facts below come from each project's README and registry page, linked in the first column, read on 2026-11-03. "Unknown" means the README does not say.

| Tool                                                                                                                                                                      | Language              | Interception                                                                                           | Streaming                                                      | On a mismatch                                                                                        | Partial re-record                                                                  | Last release                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| **agent-retrace**                                                                                                                                                         | TypeScript            | HTTP: Node's global undici dispatcher, so SDK clients built at module load are covered too             | SSE stored as events, replayed as a stream                     | Fails at the first changed step: "changed at step N of M", a semantic diff and the re-record command | Yes: `update` mode replays the unchanged steps and re-records from the changed one | Not yet published            |
| [tomiko](https://github.com/Tomiko-M/tomiko) ([npm](https://www.npmjs.com/package/tomiko))                                                                                | TypeScript            | Patches `globalThis.fetch` during a test; a client built at module load must be given tomiko's `fetch` | SSE replayed chunk by chunk                                    | Fails with the closest recorded request and a field diff; optional fuzzy matching                    | Per cassette (`tomiko record --stale`, `TOMIKO_RECORD`), not per step              | 0.2.0, 2026-10-13            |
| [llm-cassette](https://github.com/mhamadkadiry/llm-vcr) ([npm](https://www.npmjs.com/package/llm-cassette))                                                               | TypeScript            | Unknown (configured in a setup file)                                                                   | SSE recorded and replayed                                      | `onMiss: "error"` fails the test; error contents unknown                                             | `onMiss: "record"` records requests with no match                                  | 0.1.0, 2026-04-05            |
| [llm-cassette](https://github.com/thbabs/llm-cassette) ([PyPI](https://pypi.org/project/llm-cassette/))                                                                   | Python                | Patches OpenAI and Anthropic SDK methods; `@tool` for tools                                            | Replayed as the SDKs' stream objects                           | `CassetteMismatchError` with the expected and received requests                                      | No: `record` rewrites the file                                                     | 0.1.0, 2026-10-21            |
| [agent-replay](https://github.com/retr0hxx/agent-replay) ([npm](https://www.npmjs.com/package/@retr0hxx/agent-replay), [PyPI](https://pypi.org/project/agent-replay-py/)) | TypeScript and Python | Patched global `fetch` (TS); its own `httpx` client (Python)                                           | Unknown                                                        | A structured diff report; warns or throws, by policy                                                 | Unknown                                                                            | 0.1.0, 2026-07-19            |
| [agent-replay](https://github.com/joshuashley/agent-replay) ([PyPI `replay-agent`](https://pypi.org/project/replay-agent/))                                               | Python                | Patches SDK methods; LangChain and LangGraph hooks                                                     | Assembled, then re-chunked on replay                           | `assert_trace_unchanged` reports semantic changes ("extra LLM call", "new tool used")                | No: `--record-mode=all`                                                            | 0.4.0, 2026-03-28 (archived) |
| [agentverify](https://github.com/simukappu/agentverify) ([PyPI](https://pypi.org/project/agentverify/))                                                                   | Python                | Patches SDK methods; adapters for seven agent frameworks                                               | Recorded; replayed as one chunk of text plus one per tool call | `CassetteRequestMismatchError` with a diff; lists stale cassettes and the command to re-record each  | No: `RECORD` re-records the cassette                                               | 0.8.0, 2026-10-30            |

Where others are ahead:

- **tomiko** is the most complete TypeScript option. It has Vitest matchers for tool calls, cost and model; fault injection (rate limits, cut streams, hallucinated tool calls); a viewer; cost and model-comparison commands; secret scanning; and support for Gemini and LangChain.js.
- **agentverify** has step-level assertions on what the agent did, adapters for LangChain, LangGraph, CrewAI and more, cassette expiry, and a stale-cassette summary at the end of a run.
- The Python tools cover frameworks that agent-retrace does not (it is TypeScript and Node only, and supports OpenAI and Anthropic).

`cassette` and `retake`, sometimes listed among these tools, are not covered: the npm and PyPI packages with those names are unrelated projects, and no LLM record-and-replay project by those exact names could be identified.

## License

[MIT](LICENSE)
