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

test("runtime starts with default config and nothing installed", async () => {
  const { runtime } = await import("../../src/runtime.js");
  const rt = runtime();
  expect(rt.activePaths).toBeInstanceOf(Set);
  expect(rt.activePaths.size).toBe(0);
  expect(rt.installed).toEqual({});
  expect(rt.config.providerHosts).toEqual(["api.openai.com", "api.anthropic.com"]);
});

test("runtime has no runtime import of config, so the two cannot form a cycle", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/runtime.ts", import.meta.url), "utf8");
  // `import type` is erased at compile time and cannot create a load-order cycle.
  expect(source).not.toMatch(/^import (?!type\b).*["']\.\/config\.js["']/m);
});
