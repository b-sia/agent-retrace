# Recording format

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
