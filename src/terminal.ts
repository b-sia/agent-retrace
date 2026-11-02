/**
 * Helpers for writing text to a terminal: the shared color functions and
 * one-line formatting.
 */
import type pc from "picocolors";

/** A set of picocolors functions, all identity functions when color is off. */
export type Colors = ReturnType<typeof pc.createColors>;

/**
 * Makes text fit on one line by writing newlines as the two characters `\n`.
 *
 * @param text - Any text.
 * @returns The one-line text.
 */
export function oneLine(text: string): string {
  return text.replace(/\r?\n/g, "\\n");
}
