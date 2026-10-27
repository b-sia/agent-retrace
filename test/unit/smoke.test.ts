/**
 * Smoke test: the package entry point loads as an ES module.
 */
import { expect, test } from "vitest";
import * as lib from "../../src/index.js";

test("entry point loads", () => {
  expect(typeof lib).toBe("object");
});
