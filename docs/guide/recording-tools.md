# Recording tool calls: `recordTool`

Provider calls are recorded automatically. Your agent's own tools are recorded when you wrap them:

```ts
import { recordTool } from "agent-retrace";

export const lookupOrder = recordTool("lookup_order", async (orderId: string) => {
  return db.orders.find(orderId);
});
```

Inside `replay()`, a replayed call returns the recorded result (or throws the recorded error) without running the tool, so tests need no database, no tool credentials and cause no side effects. A tool call matches on its name and arguments. Outside `replay()`, the wrapper just calls the tool. Unwrapped tools always run for real.

## Things to know

- **The wrapper is always async**, even when the tool is not: `recordTool("add", (a, b) => a + b)` returns a function that returns a `Promise`.
- Results are stored as JSON. Inside `replay()` the caller gets the stored copy whether the tool ran or not, so a recording run behaves exactly like its replays: a `Date` comes back as its ISO string, a class instance as a plain object.
- Errors are stored by name, message, primitive fields (`code`, `status`) and cause. Built-in classes such as `TypeError` keep their class; other errors come back as a plain `Error` with the original `name`.
- To leave an argument out of matching and the recording (a logger, a client handle), pick the ones that count: `recordTool("search", searchImpl, { args: (query, _client) => [query] })`. The tool still receives all of its arguments.

## Vercel AI SDK tools

`execute` is called as `execute(input, options)`, and `options` carries the conversation so far (`messages`). Wrapped as is, every tool step stores the whole conversation and matches on it. Keep only the input:

```ts
execute: recordTool("get_weather", getWeather, { args: (input) => [input] }),
```
