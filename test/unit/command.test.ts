/**
 * Tests for test runner detection and the re-record command.
 */
import { expect, test } from "vitest";
import { detectRunner, rerecordCommand, runCommand } from "../../src/diff/command.js";

test("detectRunner", () => {
  expect(detectRunner({ VITEST: "true" }, [], [])).toBe("vitest");
  expect(detectRunner({}, ["--test"], [])).toBe("node-test");
  expect(detectRunner({}, [], ["node", "--test", "x.js"])).toBe("node-test");
  expect(detectRunner({}, [], ["node", "x.js"])).toBe("unknown");
});

test("detectRunner sees node --test child processes", () =>
  expect(detectRunner({ NODE_TEST_CONTEXT: "child-v8" }, [], ["node", "x.js"])).toBe("node-test"));

test("detectRunner ignores flags passed to the script itself", () =>
  expect(detectRunner({}, [], ["node", "x.js", "--test"])).toBe("unknown"));

test("detectRunner defaults to this process", () => expect(detectRunner()).toBe("vitest"));

test("rerecordCommand per runner", () => {
  expect(rerecordCommand("vitest", "/w/test/a.test.ts", "/w")).toBe(
    "AGENT_RETRACE_MODE=update npx vitest run test/a.test.ts",
  );
  expect(rerecordCommand("node-test", "/w/test/a.test.mjs", "/w")).toBe(
    "AGENT_RETRACE_MODE=update node --test test/a.test.mjs",
  );
  expect(rerecordCommand("unknown", "/w/test/a.test.ts", "/w")).toBe(
    "AGENT_RETRACE_MODE=update <your test command>",
  );
  expect(rerecordCommand("vitest", undefined, "/w")).toBe(
    "AGENT_RETRACE_MODE=update <your test command>",
  );
});

test("rerecordCommand quotes paths the shell would split", () =>
  expect(rerecordCommand("vitest", "/w/my tests/it's.test.ts", "/w")).toBe(
    "AGENT_RETRACE_MODE=update npx vitest run 'my tests/it'\\''s.test.ts'",
  ));

test("runCommand runs the file without a mode", () => {
  expect(runCommand("vitest", "/w/test/a.test.ts", "/w")).toBe("npx vitest run test/a.test.ts");
  expect(runCommand("node-test", "/w/a.test.mjs", "/w")).toBe("node --test a.test.mjs");
  expect(runCommand("unknown", "/w/a.test.ts", "/w")).toBe("<your test command>");
});
