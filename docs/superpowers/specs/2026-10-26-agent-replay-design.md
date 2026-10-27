# Agent Record-and-Replay with Change Detection - Design

Date: 2026-10-26
Status: Draft for review
Name: `agent-retrace` (npm package, CLI binary and GitHub repo; confirmed free on npm 2026-10-26)

## 1. Intent and why

The owner is an engineer with Python, C++ and Go experience who wants to learn Node.js by building a portfolio project that other developers notice. AI agents are the chosen space, and testing agents is the chosen problem.

Agent tests are slow, expensive and flaky because they call live, non-deterministic models. The usual fix is to record model responses once and replay them in CI. That part is already crowded: there are around ten small "VCR for LLMs" projects (tomiko, llm-cassette, cassette, retake, agent-replay, agentverify and others), mostly v0.1 releases, mostly Python at the agent level. None of them has become the standard, and TypeScript has no strong agent-level option.

The gap this project targets: **recordings go stale.** As soon as a prompt, tool or model changes, existing tools either fail with an opaque "cassette mismatch" or call the real API for everything again. This project replays the steps that still match, finds th**e** first step where the agent changed, shows a readable diff of that change, and (when asked) re-records only from that step onward.

The headline experience: "Your agent changed at step 4 of 9," followed by a clear diff, instead of a generic mismatch error.

## 2. Users

Engineers building agents in TypeScript/JavaScript on Node who want fast, free, deterministic agent tests in CI and who change prompts often.

v1 must work with:

- the official OpenAI Node SDK (`openai`)
- the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- the Vercel AI SDK (`ai`) with its OpenAI and Anthropic providers

Later (not v1): LangGraph.js, Mastra, other providers.

## 3. Goals

1. Record an agent run (LLM calls and wrapped tool calls) as one ordered recording.
2. Replay that recording in tests with no network access, no API keys and no cost.
3. On a change, report the first changed step, its position ("step 4 of 9"), and a readable diff of what the agent sent differently.
4. In update mode, replay the unchanged prefix and re-record live from the first changed step onward.
5. Never call a real API in CI.
6. Setup in under five minutes: `npm i -D`, wrap a test, run it.
7. A repo and README polished enough for a Show HN post, with a 20-second demo GIF.
8. Code that is easy for the owner to review and learn Node from (see section 9).

## 4. Non-goals (v1)

- PR comments / GitHub integration (planned next, see section 11).
- Freezing the clock, random numbers or other non-HTTP non-determinism.
- Framework-specific plugins (LangGraph.js, Mastra).
- A hosted service, dashboard or web UI.
- Evaluating output quality (LLM-as-judge, scoring). This is a replay tool, not an eval framework.
- Non-Node runtimes (Deno, Bun, browsers). Nice if they happen to work; not tested or promised.
- Providers other than OpenAI and Anthropic.

## 5. Anti-goals (failure even if it technically works)

- **Leaking secrets.** API keys, auth headers or similar must never be written to a recording file. Recordings are committed to git.
- **Silent real API calls in CI.** If any request to an LLM provider (see 6.2) would hit the network in CI, the test fails loudly instead. Other traffic is not blocked (see 6.6).
- **Silent re-recording.** Recordings only change when the user explicitly asks (update mode), the same way snapshot tests work.
- **Requiring app code changes.** Users wrap their *tests*, not their agent code. The only exception is the optional tool wrapper.
- **Opaque errors.** A mismatch that just says "no match found" is the exact problem this project exists to fix.
- **Being clone number eleven.** If the change-detection and diff experience is not clearly better than the existing tools, the project has failed its purpose.

## 6. How it behaves (v1)

### 6.1 Test API

```ts
import { replay } from "agent-retrace";

test("support agent refunds a damaged order", async () => {
  await replay("refund-damaged-order", async () => {
    const result = await runSupportAgent("My order arrived broken");
    expect(result.action).toBe("refund");
  });
});
```

- Works with Vitest (primary, documented and tested) and `node:test`. Other runners are a bonus.
- `replay(name, fn)` scopes a recording to one test. Recordings for concurrent tests must not mix (use async context tracking, e.g. `AsyncLocalStorage`, rather than global state).

### 6.2 What gets recorded

- **LLM calls:** intercepted at the HTTP level for requests to the OpenAI and Anthropic APIs, so the SDKs and anything built on them work unchanged. Requests to other hosts pass through untouched in every mode and are not part of the recording.
- **Which hosts count as providers** *(coding agent's call)*: `api.openai.com` and `api.anthropic.com` by default, plus any extra hosts the user configures (for Azure OpenAI, corporate proxies or gateways that speak the OpenAI or Anthropic API). A configured host is treated exactly like a default one. The README must say clearly that a custom `baseURL` has to be added to this list, otherwise its calls are not recorded or blocked.
- **Streaming responses (SSE) must be supported.** Agents commonly stream. Replay must deliver the recorded stream as a stream so the SDK behaves the same as live.
- **Tool calls:** recorded only if the user wraps the tool, e.g. `const search = recordTool("search", searchImpl)`. In replay, the wrapper returns the recorded result without running the real tool. Unwrapped tools always run for real.
- Each recording is one ordered list of steps. A step is either an LLM call (request + response) or a tool call (name + arguments + result or error).

### 6.3 Recording files

- One human-readable JSON file per recording, stored next to the test in a `__recordings__/` folder, meant to be committed to git.
- Must be readable and diffable in code review: stable key order, pretty-printed, streamed responses stored in a readable form.
- Includes a format version field so the format can evolve.
- Auth headers and API keys are always stripped. Users can add their own redaction rules for other sensitive fields.

### 6.4 Matching

- A recorded LLM step matches a live request when the meaningful parts of the request are equal: endpoint, model, messages, system prompt, tools/tool schemas, and generation parameters.
- Fields that vary run to run (request IDs, timestamps, SDK version headers and similar) are ignored. Users can add their own ignore rules.
- Tool steps match on tool name and arguments.
- Agents often make concurrent calls (parallel tool calls, parallel LLM calls). Matching must be deterministic and must not break just because concurrent calls finish in a different order. The exact algorithm is left to the builder (see section 10).

### 6.5 Change detection and the diff

When a live request does not match the recording:

- Report the first changed step: its number, total steps, and step type ("LLM call 4 of 9" or "tool `search` 4 of 9").
- Show a readable diff of what changed, focused on meaning, not raw JSON. For example: a line diff of the system prompt, which messages were added or removed, which tools were added, removed or had their schema change, model or parameter changes.
- Tell the user the exact command to re-record.
- If the agent makes *more* calls than recorded, or *fewer*, that is also reported as a change at the right step.

### 6.6 Modes

Set by an environment variable (test runners own their CLI flags), `AGENT_RETRACE_MODE`:

| Mode       | Default when             | Behavior                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `replay` | `CI` env var is set    | Replay only. Any network call to a provider host, missing recording or change fails the test. Never sends a request to a provider host. Non-provider traffic (localhost, test databases, unwrapped tools) is not blocked *(coding agent's call: blocking everything would break users' existing tests and conflict with "unwrapped tools always run for real")*. |
| `auto`   | locally                  | Replay if a recording exists. If none exists, record it live. A change fails the test with the diff (it does not re-record).                                                                                                                                                                                                                                       |
| `update` | only when set explicitly | Replay the unchanged steps, then go live from the first changed step and re-record everything after it. Steps after the change in the old recording are discarded. Tools wrapped with `recordTool` also run live from that point.                                                                                                                                |

### 6.7 CLI (minimal)

- `agent-retrace inspect <file>`: pretty-print a recording as a readable timeline of steps in the terminal.
- That is the whole v1 CLI. Recording, replaying and updating all happen through the test runner.

## 7. Constraints

- TypeScript, strict mode. Supports Node.js 22 and newer, i.e. every LTS line still maintained at launch (22, 24, 26) *(coding agent's call: many teams lag one LTS behind)*. `engines` is `>=22`, and CI runs a 22/24/26 matrix. The owner's machine runs Node 22.
- MIT license *(coding agent's call)*.
- GitHub repo under the owner's account (`b-sia`). The owner publishes to npm from their own account; the coding agent prepares everything up to `npm publish`.
- Published to npm as an ES module with TypeScript type definitions.
- No runtime dependency on any one AI SDK. The provider SDKs are dev dependencies used for tests and examples.
- Every function, method and class has a JSDoc comment stating purpose, parameters, return values and errors thrown (owner's global rule).
- Never use the em dash character in docs, comments or messages (owner's global rule); use "-".
- Commit messages must not list the coding agent as co-author (owner's global rule).

## 8. Decided by the owner

- Build for other engineers, in the AI agents space.
- The record-and-replay tool for agent tests, focused on the "recordings go stale" gap.
- Ship as soon as possible; the owner is available full time.
- The coding agent builds; the owner reviews.
- Name: `agent-retrace`.
- The description in sections 6.1-6.6 was played back and accepted ("seems ok to me for now").

## 9. Calls made by the coding agent (owner can override)

- Vitest as the primary test runner, `node:test` as second.
- HTTP-level interception rather than SDK-specific wrappers.
- JSON recordings in `__recordings__/` next to the test.
- The three modes and their defaults in 6.6, controlled by an env var.
- v1 scope and the non-goals list in section 4.
- Linting and formatting with Biome (one fast tool for both), enforced in CI and via a pre-commit hook.
- Learning support for review: small focused commits, comments where Node behaves differently from Python/Go, and a short `docs/learning/` note per module explaining the Node concepts it uses (event loop, streams, async context, ESM, etc.).
- A realistic example agent in `examples/` (e.g. a small customer-support agent with two or three tools) used for the README, the demo GIF and end-to-end tests.

## 10. Left to the builder

- How to intercept HTTP (e.g. undici dispatcher vs patching `fetch`), as long as all three SDKs in section 2 work unchanged.
- The matching algorithm for concurrent calls, as long as it is deterministic and order-of-completion independent.
- The exact recording file schema.
- The internal design of the diff renderer and its terminal formatting.
- Project layout, build tooling and test structure.
- CI setup (GitHub Actions).

## 11. After v1 (in rough order, not designed yet)

1. PR comment showing how agent behavior changed next to the code change.
2. Freezing clock and random numbers inside `replay()`.
3. LangGraph.js and Mastra integrations.
4. More providers (Google, OpenAI-compatible endpoints).

## 12. Success criteria for v1

- The example agent's tests pass in CI with no API keys and no network access (its tools are wrapped with `recordTool`).
- Editing the example's system prompt produces "changed at step N of M" with a diff a reader understands without docs.
- `AGENT_RETRACE_MODE=update` re-records only from the changed step, verified by API call count.
- Works with all three SDKs in section 2, including streaming.
- No secrets in any recording, verified by a test.
- README with a 20-second demo GIF, quick start, and an honest comparison with existing tools.
- Published to npm.
