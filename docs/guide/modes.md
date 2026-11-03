# Modes and change reports

## Modes

Set the mode with the `AGENT_RETRACE_MODE` environment variable.

| Mode     | Default when             | Behavior                                                                                                                                                                                                                          |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay` | `CI` env var is set      | Replay only. Any network call to a provider host, missing recording or change fails the test. Never sends a request to a provider host. Non-provider traffic (localhost, test databases, unwrapped tools) is not blocked.         |
| `auto`   | locally                  | Replay if a recording exists. If none exists, record it live. A change fails the test with the diff (it does not re-record).                                                                                                      |
| `update` | only when set explicitly | Replay the unchanged steps, then go live from the first changed step and re-record everything after it. Steps after the change in the old recording are discarded. Tools wrapped with `recordTool` also run live from that point. |

Recordings change only when you ask for it, the same way snapshot tests work.

## What a change report contains

When the agent no longer matches its recording, the test fails with `ChangeDetectedError`:

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

The report names the first step that changed, its position and type (an LLM call or a tool), and a diff of what changed, by meaning rather than raw JSON:

- a line diff of the system prompt
- messages added or removed
- tools added, removed or with a changed schema
- model or parameter changes

An agent that makes more calls than recorded, or fewer, is reported at the step where it diverged.

The test fails with `ChangeDetectedError` even if your agent catches the SDK error and carries on with a fallback answer, so a change can never pass silently.
