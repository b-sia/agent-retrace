# Example: support agent

A small customer support agent built on the official `@anthropic-ai/sdk`
(the Messages API with client tools), tested with agent-retrace.

- `agent.ts` - `runSupportAgent(message, opts?)`: calls Claude, runs the
  tools it asks for, and repeats until Claude answers without a tool call
  (at most 6 model calls). The final answer is `{ action, reply }`, where
  `action` is `refund`, `replace`, `escalate` or `answer`.
- `tools.ts` - `lookupOrder`, `issueRefund` and `searchPolicies`, each wrapped
  with `recordTool()`. They read an in-memory fake order database.
- `agent.test.ts` - three tests, each wrapped in `replay()`.
- `__recordings__/` - the committed recordings the tests replay.

## Run it

From the repository root:

```sh
npm run test:example
```

With the committed recordings, this needs no API key and no network: every
model call and tool call is served from `__recordings__/`. CI runs it in a
container with networking turned off to prove it.

## Re-record

Delete a recording, or run in update mode, with a real key:

```sh
ANTHROPIC_API_KEY=sk-ant-... AGENT_RETRACE_MODE=update npm run test:example
```

## See a change report

The third test changes the system prompt and checks the failure agent-retrace
reports. To see it yourself, append a line to `DEFAULT_SYSTEM_PROMPT` in
`agent.ts` and run the tests:

```text
Your agent changed at step 1 of N: ...
  system prompt
  + Always offer a discount code.
```

Inspect a recording with the CLI:

```sh
npx agent-retrace inspect examples/support-agent/__recordings__/refund-damaged-order.json
```
