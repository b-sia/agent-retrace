# agent-retrace

Record your agent's LLM and tool calls once, replay them offline in every test run, and when the agent changes, see exactly which step changed and how: "Your agent changed at step 1 of 6", with a readable diff.

![Demo: the example agent's tests pass from recordings, a system prompt edit is reported as a change at step 1 of 6 with a diff](docs/demo/demo.gif)

- **Offline and free in CI.** Provider calls are served from recordings committed next to your tests. In CI, any call that would reach a provider fails the test instead.
- **Changes, not "cassette mismatch".** When a prompt, a tool or a parameter changes, agent-retrace replays the steps that still match, stops at the first one that does not, and shows what the agent now sends differently.
- **Re-record from the changed step only.** Update mode keeps the unchanged steps and calls the real API only from the change onward.
- **No changes to your agent code.** It works at the HTTP level, so the official OpenAI and Anthropic SDKs and the Vercel AI SDK work unchanged, streaming included.

Requires Node.js 22 or newer and ESM.

## Why record and replay?

Testing an agent against a real LLM is slow, costs tokens on every run, needs an API key in CI and is flaky: the model can answer differently each time, so a test can fail when nothing in your code changed. Hand-written mocks of the SDK avoid that, but they drift from what the provider really returns and never notice when your prompt or tools change.

Record and replay sits in between. The test runs against the real API once, and every request and response is saved to a file. From then on the saved responses are served instead, so tests are:

- **Deterministic:** the same model output on every run.
- **Fast, free and offline:** no network, no tokens, no API key.
- **Realistic:** the responses are the provider's own, streaming included.
- **A regression check:** each request the agent sends is compared with the recorded one, so a changed prompt, tool schema or model setting shows up as a diff, like a snapshot test.

agent-retrace hooks in below the SDKs, at the HTTP layer, and wraps your tools, so your agent code stays as it is:

![Your test calls replay(), which runs your agent. The agent's LLM SDK goes through the agent-retrace HTTP interceptor and its tools through the recordTool() wrapper. Both read and write the recording file, and reach the provider API or your real tool only when recording.](docs/diagrams/overview.svg)

[How record and replay works](docs/guide/how-it-works.md) walks through the first run, later runs and a changed agent step by step, with diagrams.

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

Every later run, locally or in CI, replays the recording: no network, no API key, no cost.

> [!IMPORTANT]
> **Using a custom `baseURL`** (Azure OpenAI, a proxy, an LLM gateway)? Add its host to [`providerHosts`](docs/guide/configuration.md#provider-hosts), or its calls are not recorded.

A complete, runnable example lives in [`examples/support-agent`](examples/support-agent).

## When your agent changes

Edit the example agent's system prompt and run its tests again. The test fails and tells you where and how the agent changed:

```text
ChangeDetectedError: agent-retrace: recording "refund-damaged-order" no longer matches.
Your agent changed at step 1 of 6: LLM call (POST api.anthropic.com/v1/messages)

System prompt:
  ...
  Keep the reply short and friendly.
+ Always offer a discount code.

To accept this change and re-record from step 1, run:
  AGENT_RETRACE_MODE=update npx vitest run examples/support-agent/agent.test.ts
```

If the change is intended, run the printed command. Only the steps from the change onward call the real API.

## Recording your own tools

Provider calls are recorded automatically. Wrap your agent's tools with `recordTool` so replays need no database and cause no side effects:

```ts
import { recordTool } from "agent-retrace";

export const lookupOrder = recordTool("lookup_order", async (orderId: string) => {
  return db.orders.find(orderId);
});
```

## Documentation

- [How record and replay works](docs/guide/how-it-works.md) - why record and replay, where agent-retrace sits, and what happens on each run, with diagrams
- [Modes and change reports](docs/guide/modes.md) - `replay`, `auto` and `update`, and what a change report contains
- [Recording tool calls](docs/guide/recording-tools.md) - `recordTool` details, argument selection, Vercel AI SDK tools
- [Configuration](docs/guide/configuration.md) - provider hosts, redaction, ignored fields
- [Test runners](docs/guide/test-runners.md) - Vitest setup file, `node:test`, where recordings go
- [CLI](docs/guide/cli.md) - `agent-retrace inspect`
- [Recording format](docs/guide/recording-format.md) - what is stored on disk
- [Limitations](docs/guide/limitations.md) - supported clients and known caveats

## License

[MIT](LICENSE)
