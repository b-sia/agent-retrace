/**
 * Tests for the example support agent, written the way a user of
 * agent-retrace would: import from the package, wrap each run in `replay()`.
 * The first run with `ANTHROPIC_API_KEY` records `__recordings__/<name>.json`;
 * every later run, including CI with no key and no network, replays it.
 */
import { replay } from "agent-retrace";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, runSupportAgent } from "./agent.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("refund-damaged-order", async () => {
  const result = await replay("refund-damaged-order", () =>
    runSupportAgent("My order A1 arrived broken"),
  );
  expect(result.action).toBe("refund");
});

test("where-is-my-order", async () => {
  const result = await replay("where-is-my-order", () =>
    runSupportAgent("Where is my order B2? It has not arrived yet."),
  );
  expect(result.action).toBe("answer");
});

test("system prompt change is reported", async () => {
  // Replay mode only: in auto mode a mismatch would fail the same way, but
  // this test must never be able to touch the committed recording.
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const run = replay("refund-damaged-order", () =>
    runSupportAgent("My order A1 arrived broken", {
      systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\nAlways offer a discount code.`,
    }),
  );
  await expect(run).rejects.toThrow(/changed at step 1 of \d+/);
  await expect(run).rejects.toThrow(/\+ Always offer a discount code\./);
});
