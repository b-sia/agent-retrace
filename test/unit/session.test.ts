/**
 * Tests for the replay session state machine.
 */
import { expect, test, vi } from "vitest";
import { defaultConfig } from "../../src/defaults.js";
import { ChangeDetectedError } from "../../src/errors.js";
import type { LlmStep, Recording, Step, ToolStep } from "../../src/recording/format.js";
import { type Decision, Session, type Strategy } from "../../src/session.js";

type Live<S extends Step> = Extract<Decision<S>, { kind: "live" }>;

const COMMAND = "AGENT_RETRACE_MODE=update npx vitest run test/a.test.ts";

/**
 * Builds a recording.
 *
 * @param steps - The recorded steps.
 * @returns The recording.
 */
function rec(...steps: Step[]): Recording {
  return { formatVersion: 1, name: "demo", steps };
}

/**
 * Builds an LLM step identified by `id`; steps with different ids do not match.
 *
 * @param id - Distinguishes the request, and is echoed in the response body.
 * @param respId - Response id, to tell apart steps with identical requests.
 * @returns The step.
 */
function llm(id: string, respId: string = id): LlmStep {
  return {
    type: "llm",
    request: {
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      body: { model: "m", messages: [{ role: "user", content: id }] },
    },
    response: { status: 200, headers: {}, body: { id: respId } },
  };
}

/**
 * Builds a tool step that returned nothing.
 *
 * @param name - Tool name.
 * @param arg - Single argument.
 * @returns The step.
 */
function tool(name: string, arg: number): ToolStep {
  return { type: "tool", name, args: [arg], outcome: { type: "return" } };
}

/**
 * Creates a session with a save spy.
 *
 * @param strategy - The session strategy.
 * @param recording - The existing recording, if any.
 * @returns The session and the spy.
 */
function session(strategy: Strategy, recording?: Recording) {
  const save = vi.fn(async (_r: Recording) => {});
  const s = new Session({
    name: "demo",
    recordingPath: "/work/app/__recordings__/demo.json",
    strategy,
    recording,
    command: COMMAND,
    config: defaultConfig(),
    save,
  });
  return { s, save };
}

/**
 * Asserts a decision is a replay and returns its step.
 *
 * @param d - The decision.
 * @returns The replayed step.
 */
function replayed<S extends Step>(d: Decision<S>): S {
  if (d.kind !== "replay") throw new Error(`expected replay, got ${d.kind}`);
  return d.step;
}

test("strict replays in order", async () => {
  const { s, save } = session("strict", rec(llm("a"), tool("t", 1), llm("b")));
  expect(replayed(s.decideLlm(llm("a").request))).toEqual(llm("a"));
  expect(replayed(s.decideTool("t", [1]))).toEqual(tool("t", 1));
  expect(replayed(s.decideLlm(llm("b").request))).toEqual(llm("b"));
  await expect(s.finish(undefined)).resolves.toBeUndefined();
  expect(save).not.toHaveBeenCalled();
});

test("strict tolerates reversed concurrent order", () => {
  const { s } = session("strict", rec(llm("a"), llm("b")));
  expect(replayed(s.decideLlm(llm("b").request))).toEqual(llm("b"));
  expect(replayed(s.decideLlm(llm("a").request))).toEqual(llm("a"));
});

test("identical requests consume in recorded order", () => {
  const { s } = session("strict", rec(llm("a", "1"), llm("a", "2")));
  expect(replayed(s.decideLlm(llm("a").request)).response.body).toEqual({ id: "1" });
  expect(replayed(s.decideLlm(llm("a").request)).response.body).toEqual({ id: "2" });
});

test("changed request fails and reports step", async () => {
  const { s } = session("strict", rec(llm("a"), llm("b"), llm("c")));
  s.decideLlm(llm("a").request);
  const d = s.decideLlm(llm("B!").request);
  expect(d.kind).toBe("fail");
  await expect(s.finish(undefined)).rejects.toThrow(/changed at step 2 of 3/);
});

test("changed request compares against the earliest unconsumed LLM step", async () => {
  const { s } = session("strict", rec(tool("t", 1), llm("a")));
  const d = s.decideLlm(llm("A!").request);
  if (d.kind !== "fail") throw new Error("expected fail");
  expect(d.error).toBeInstanceOf(ChangeDetectedError);
  expect(d.error.stepNumber).toBe(2);
  expect(d.error.totalSteps).toBe(2);
  expect(d.error.recordingName).toBe("demo");
  expect(d.error.message).toContain(COMMAND);
});

test("changed tool call prefers the same tool name", async () => {
  const { s } = session("strict", rec(tool("x", 1), tool("t", 2)));
  const d = s.decideTool("t", [3]);
  if (d.kind !== "fail") throw new Error("expected fail");
  expect(d.error.stepNumber).toBe(2);
});

test("changed tool call falls back to the earliest unconsumed tool step", async () => {
  const { s } = session("strict", rec(llm("a"), tool("x", 1), tool("y", 2)));
  const d = s.decideTool("t", [3]);
  if (d.kind !== "fail") throw new Error("expected fail");
  expect(d.error.stepNumber).toBe(2);
});

test("a call with no unconsumed step of its type compares against the earliest step of any type", async () => {
  const { s } = session("strict", rec(llm("a"), llm("b")));
  const d = s.decideTool("t", [1]);
  if (d.kind !== "fail") throw new Error("expected fail");
  expect(d.error.stepNumber).toBe(1);
  expect(d.error.message).toMatch(/changed at step 1 of 2/);
});

test("extra call", async () => {
  const { s } = session("strict", rec(llm("a")));
  expect(s.decideLlm(llm("a").request).kind).toBe("replay");
  const d = s.decideLlm(llm("a").request);
  expect(d.kind).toBe("fail");
  await expect(s.finish(undefined)).rejects.toThrow(/more calls than recorded: step 2 is new/);
});

test("extra call numbers continue after earlier extras", async () => {
  const { s } = session("strict", rec(llm("a")));
  s.decideLlm(llm("a").request);
  s.decideLlm(llm("x").request);
  const d = s.decideLlm(llm("y").request);
  expect(d.kind).toBe("fail");
  // Only the first mismatch is reported.
  await expect(s.finish(undefined)).rejects.toThrow(/step 2 is new/);
});

test("fewer calls", async () => {
  const { s } = session("strict", rec(llm("a"), llm("b"), llm("c")));
  s.decideLlm(llm("a").request);
  s.decideLlm(llm("b").request);
  await expect(s.finish(undefined)).rejects.toThrow(/fewer calls than recorded: step 3 of 3/);
});

test("fewer calls reports the earliest unconsumed step", async () => {
  const { s } = session("strict", rec(llm("a"), llm("b"), llm("c")));
  s.decideLlm(llm("c").request);
  await expect(s.finish(undefined)).rejects.toThrow(/fewer calls than recorded: step 1 of 3/);
});

test("only the first mismatch is reported", async () => {
  const { s } = session("strict", rec(llm("a"), llm("b")));
  s.decideLlm(llm("A!").request);
  s.decideLlm(llm("B!").request);
  await expect(s.finish(undefined)).rejects.toThrow(/changed at step 1 of 2/);
});

test("mismatch wins over fn error and keeps it as cause", async () => {
  const { s } = session("strict", rec(llm("a")));
  s.decideLlm(llm("A!").request);
  const e = new Error("sdk blew up");
  const err = await s.finish({ error: e }).catch((x: unknown) => x);
  expect(err).toBeInstanceOf(ChangeDetectedError);
  expect((err as ChangeDetectedError).cause).toBe(e);
});

test("fn error rethrown when no mismatch", async () => {
  const { s } = session("strict", rec(llm("a")));
  s.decideLlm(llm("a").request);
  const e = new Error("agent bug");
  await expect(s.finish({ error: e })).rejects.toBe(e);
});

test("fn error wins over fewer calls", async () => {
  const { s } = session("strict", rec(llm("a"), llm("b")));
  s.decideLlm(llm("a").request);
  const e = new Error("agent bug");
  await expect(s.finish({ error: e })).rejects.toBe(e);
});

test("record is live for every decision", () => {
  const { s } = session("record");
  expect(s.decideLlm(llm("a").request).kind).toBe("live");
  expect(s.decideTool("t", [1]).kind).toBe("live");
});

test("record saves in issue order regardless of commit order", async () => {
  const { s, save } = session("record");
  const d1 = s.decideLlm(llm("a").request) as Live<LlmStep>;
  const d2 = s.decideLlm(llm("b").request) as Live<LlmStep>;
  d2.commit(llm("b"));
  d1.commit(llm("a"));
  await s.finish(undefined);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]?.[0]).toEqual(rec(llm("a"), llm("b")));
});

test("record drops undefined commits", async () => {
  const { s, save } = session("record");
  const d1 = s.decideLlm(llm("a").request) as Live<LlmStep>;
  const d2 = s.decideLlm(llm("b").request) as Live<LlmStep>;
  d1.commit(undefined);
  d2.commit(llm("b"));
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0].steps).toEqual([llm("b")]);
});

test("record does not save when fn failed", async () => {
  const { s, save } = session("record");
  const d = s.decideLlm(llm("a").request) as Live<LlmStep>;
  d.commit(llm("a"));
  const e = new Error("agent bug");
  await expect(s.finish({ error: e })).rejects.toBe(e);
  expect(save).not.toHaveBeenCalled();
});

test("update switches to live at first change and stays live", async () => {
  const { s, save } = session("update", rec(llm("a"), tool("t", 1), llm("c"), llm("d")));
  expect(s.decideLlm(llm("a").request).kind).toBe("replay");
  expect(s.decideTool("t", [1]).kind).toBe("replay");
  const d3 = s.decideLlm(llm("c2").request);
  expect(d3.kind).toBe("live");
  const d4 = s.decideLlm(llm("d").request);
  expect(d4.kind).toBe("live"); // would match, still live
  (d3 as Live<LlmStep>).commit(llm("c2"));
  (d4 as Live<LlmStep>).commit(llm("d"));
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0].steps).toEqual([llm("a"), tool("t", 1), llm("c2"), llm("d")]);
});

test("update keeps consumed recorded steps in their original order", async () => {
  const { s, save } = session("update", rec(llm("a"), llm("b"), llm("c")));
  // Concurrent calls consume out of order, then a change switches to live.
  s.decideLlm(llm("b").request);
  s.decideLlm(llm("a").request);
  const d = s.decideLlm(llm("c2").request) as Live<LlmStep>;
  d.commit(llm("c2"));
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0].steps).toEqual([llm("a"), llm("b"), llm("c2")]);
});

test("update with no change does not write", async () => {
  const { s, save } = session("update", rec(llm("a"), llm("b")));
  s.decideLlm(llm("a").request);
  s.decideLlm(llm("b").request);
  await s.finish(undefined);
  expect(save).not.toHaveBeenCalled();
});

test("update with fewer calls truncates", async () => {
  const { s, save } = session("update", rec(llm("a"), llm("b"), llm("c")));
  s.decideLlm(llm("a").request);
  s.decideLlm(llm("b").request);
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0].steps).toEqual([llm("a"), llm("b")]);
});

test("update with an extra call appends it", async () => {
  const { s, save } = session("update", rec(llm("a")));
  s.decideLlm(llm("a").request);
  const d = s.decideLlm(llm("x").request) as Live<LlmStep>;
  expect(d.kind).toBe("live");
  d.commit(llm("x"));
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0].steps).toEqual([llm("a"), llm("x")]);
});

test("update drops undefined commits", async () => {
  const { s, save } = session("update", rec(llm("a")));
  const d = s.decideLlm(llm("x").request) as Live<LlmStep>;
  d.commit(undefined);
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0].steps).toEqual([]);
});

test("update with an fn error does not save and rethrows", async () => {
  const { s, save } = session("update", rec(llm("a")));
  const d = s.decideLlm(llm("x").request) as Live<LlmStep>;
  d.commit(llm("x"));
  const e = new Error("agent bug");
  await expect(s.finish({ error: e })).rejects.toBe(e);
  expect(save).not.toHaveBeenCalled();
});

test("strict and update without a recording treat every call as extra", () => {
  expect(session("strict", rec()).s.decideLlm(llm("a").request).kind).toBe("fail");
  expect(session("update", rec()).s.decideLlm(llm("a").request).kind).toBe("live");
});

test("closed after finish, even when saving fails", async () => {
  const { s } = session("strict", rec());
  expect(s.closed).toBe(false);
  await s.finish(undefined);
  expect(s.closed).toBe(true);

  const failing = new Session({
    name: "demo",
    recordingPath: "/p.json",
    strategy: "record",
    recording: undefined,
    command: COMMAND,
    config: defaultConfig(),
    save: async () => {
      throw new Error("disk full");
    },
  });
  await expect(failing.finish(undefined)).rejects.toThrow("disk full");
  expect(failing.closed).toBe(true);
});

test("exposes its name", () => {
  expect(session("record").s.name).toBe("demo");
});
