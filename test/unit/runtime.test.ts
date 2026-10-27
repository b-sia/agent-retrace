/**
 * Tests for the process-wide runtime singleton.
 */
import { expect, test } from "vitest";

test("runtime is shared across module copies", async () => {
  const a = await import("../../src/runtime.js");
  // A query string makes Vitest evaluate a second copy of the module, like a
  // package installed twice. Built at runtime so tsc does not try to resolve it.
  const copySpecifier = "../../src/runtime.js?copy=2";
  const b: typeof a = await import(copySpecifier);
  expect(a).not.toBe(b);
  expect(a.runtime()).toBe(b.runtime());
});

test("runtime starts with empty state", async () => {
  const { runtime } = await import("../../src/runtime.js");
  const rt = runtime();
  expect(rt.activePaths).toBeInstanceOf(Set);
  expect(rt.config.providerHosts).toEqual(["api.openai.com", "api.anthropic.com"]);
});
