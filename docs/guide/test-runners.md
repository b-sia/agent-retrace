# Test runners

## Where recordings go

Recordings go to `__recordings__/` next to the file that calls `replay()`. Pass `{ dir }` as the third argument to put them elsewhere.

Concurrent tests each get their own recording: sessions are tracked with `AsyncLocalStorage`, not global state.

## Vitest: blocking provider calls outside `replay()`

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
