/**
 * Helpers for writing text to a terminal: the shared color functions, and
 * escaping so that text from a recording cannot drive the terminal.
 */
import type pc from "picocolors";

/** A set of picocolors functions, all identity functions when color is off. */
export type Colors = ReturnType<typeof pc.createColors>;

// The usual escapes; any other control character is written as \uXXXX.
const ESCAPES: Record<string, string> = { "\r\n": "\\n", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * Makes text safe to print on one terminal line. Newlines become the two
 * characters `\n`, and every other C0 or C1 control character and DEL is
 * escaped too (`\r`, `\t`, `\u001b`), so recorded text cannot move the
 * cursor, clear the screen or retitle the terminal with escape sequences.
 *
 * @param text - Any text.
 * @returns The one-line text, free of control characters.
 */
export function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  return text.replace(/\r\n|[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
    return ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
