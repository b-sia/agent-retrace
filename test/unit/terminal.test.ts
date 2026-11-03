/**
 * Tests for the terminal helpers.
 */
import { describe, expect, test } from "vitest";
import { oneLine } from "../../src/terminal.js";

describe("oneLine", () => {
  test.each([
    ["a\nb\r\nc", "a\\nb\\nc"],
    ["a\rb\tc", "a\\rb\\tc"],
    ["\u001b[2J\u0007\u0000", "\\u001b[2J\\u0007\\u0000"],
    ["del\u007f csi\u009b nbsp ", "del\\u007f csi\\u009b nbsp "],
    ["plain 😀", "plain 😀"],
  ])("escapes %j", (input, expected) => expect(oneLine(input)).toBe(expected));

  test("is idempotent", () => {
    const once = oneLine("x\u001b\r\ny");
    expect(oneLine(once)).toBe(once);
  });
});
