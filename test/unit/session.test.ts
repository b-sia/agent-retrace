/**
 * Tests for the replay session state machine.
 */
import { stripVTControlCharacters } from "node:util";
import { expect, test, vi } from "vitest";
import { defaultConfig } from "../../src/defaults.js";
import {
  ChangeDetectedError,
  ProviderCallBlockedError,
  ReplayUsageError,
} from "../../src/errors.js";
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

test.each<[string, Recording, number]>([
  ["the earliest unconsumed step with the same tool name", rec(tool("x", 1), tool("t", 2)), 2],
  ["else the earliest unconsumed tool step", rec(llm("a"), tool("x", 1), tool("y", 2)), 2],
  ["else the earliest unconsumed step of any type", rec(llm("a"), llm("b")), 1],
])("a changed tool call is compared against %s", (_, recording, stepNumber) => {
  const d = session("strict", recording).s.decideTool("t", [3]);
  if (d.kind !== "fail") throw new Error("expected fail");
  expect(d.error.stepNumber).toBe(stepNumber);
  expect(d.error.message).toContain(`changed at step ${stepNumber} of`);
});

test("extra call", async () => {
  const { s } = session("strict", rec(llm("a")));
  expect(s.decideLlm(llm("a").request).kind).toBe("replay");
  const d = s.decideLlm(llm("a").request);
  expect(d.kind).toBe("fail");
  await expect(s.finish(undefined)).rejects.toThrow(/more calls than recorded: step 2 is new/);
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

test.each<[string, (report: ChangeDetectedError) => Error | undefined]>([
  ["no error from the function", () => undefined],
  ["the report rethrown by the function", (report) => report],
  [
    "the report wrapped by the SDK",
    (report) =>
      new Error("Connection error.", { cause: new Error("fetch failed", { cause: report }) }),
  ],
  [
    // OpenAI-style: the report as plain text after the status.
    "an SDK error quoting the report as text",
    (report) => new Error(`400 ${stripVTControlCharacters(report.message)}`),
  ],
  [
    // Anthropic-style: the raw error body, so the report is JSON-escaped.
    "an SDK error quoting the report as JSON",
    (report) => {
      const message = stripVTControlCharacters(report.message);
      const body = { type: "error", error: { type: "agent_retrace_error", message } };
      return new Error("wrapped", { cause: new Error(`400 ${JSON.stringify(body)}`) });
    },
  ],
])("strict finish throws the failed decision's report unwrapped, given %s", async (_, fnError) => {
  const { s } = session("strict", rec(llm("a")));
  const d = s.decideLlm(llm("A!").request);
  if (d.kind !== "fail") throw new Error("expected fail");
  const error = fnError(d.error);
  await expect(s.finish(error && { error })).rejects.toBe(d.error);
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

test("record saves in reservation order when requests are decided out of order", async () => {
  const { s, save } = session("record");
  const decideA = s.reserveLlm();
  const decideB = s.reserveLlm();
  // B's body was read first, so its decision comes first.
  (decideB(llm("b").request) as Live<LlmStep>).commit(llm("b"));
  (decideA(llm("a").request) as Live<LlmStep>).commit(llm("a"));
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0]).toEqual(rec(llm("a"), llm("b")));
});

test("a reservation decided after finish throws", async () => {
  const { s } = session("record");
  const decide = s.reserveLlm();
  await s.finish(undefined);
  expect(() => decide(llm("a").request)).toThrow(ProviderCallBlockedError);
});

test("record and update drop undefined commits", async () => {
  const record = session("record");
  const d1 = record.s.decideLlm(llm("a").request) as Live<LlmStep>;
  const d2 = record.s.decideLlm(llm("b").request) as Live<LlmStep>;
  d1.commit(undefined);
  d2.commit(llm("b"));
  await record.s.finish(undefined);
  expect(record.save.mock.calls[0]?.[0].steps).toEqual([llm("b")]);

  const update = session("update", rec(llm("a")));
  (update.s.decideLlm(llm("x").request) as Live<LlmStep>).commit(undefined);
  await update.s.finish(undefined);
  expect(update.save.mock.calls[0]?.[0].steps).toEqual([]);
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

test("update without a recording writes one even when no calls were made", async () => {
  const { s, save } = session("update");
  await s.finish(undefined);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]?.[0]).toEqual(rec());
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

test("commit twice is a bug and throws", () => {
  const { s } = session("record");
  const d = s.decideLlm(llm("a").request) as Live<LlmStep>;
  d.commit(llm("a"));
  expect(() => d.commit(llm("a"))).toThrow(/more than once/);
  expect(() => d.commit(undefined)).toThrow(/more than once/);
});

test("a commit that arrives after finish is ignored", async () => {
  const { s, save } = session("record");
  const d = s.decideLlm(llm("a").request) as Live<LlmStep>;
  await s.finish(undefined);
  d.commit(llm("a"));
  expect(save.mock.calls[0]?.[0].steps).toEqual([]);
});

test("decisions after finish are refused", async () => {
  const { s } = session("record");
  await s.finish(undefined);
  expect(() => s.decideLlm(llm("a").request)).toThrow(ProviderCallBlockedError);
  expect(() => s.decideLlm(llm("a").request)).toThrow(/after its replay\(\) call had finished/);
  expect(() => s.decideTool("t", [1])).toThrow(ReplayUsageError);
  expect(() => s.decideTool("t", [1])).toThrow(
    /tool "t" was called after replay\("demo"\) had finished/,
  );
});

test("secrets noted after a step was committed are scrubbed from the saved recording", async () => {
  const { s, save } = session("record");
  const step: ToolStep = {
    type: "tool",
    name: "t",
    args: ["key sk-unit-SECRET999"],
    outcome: { type: "return", value: "sk-unit-SECRET999" },
  };
  const d = s.decideTool("t", step.args);
  if (d.kind !== "live") throw new Error(`expected live, got ${d.kind}`);
  d.commit(step);
  s.noteSecrets(["sk-unit-SECRET999"]);
  expect(s.secrets).toEqual(["sk-unit-SECRET999"]);
  await s.finish(undefined);
  expect(save.mock.calls[0]?.[0].steps).toEqual([
    { ...step, args: ["key [REDACTED]"], outcome: { type: "return", value: "[REDACTED]" } },
  ]);
});
