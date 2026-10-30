/**
 * Parsing and serialization of `text/event-stream` bodies. Pure, no I/O.
 */
import type { JsonValue, SseEvent } from "../recording/format.js";

/**
 * Parses an event stream into events. Event data that is valid JSON becomes
 * `data`, anything else (such as OpenAI's `[DONE]`) becomes `text`. Comment
 * lines and the `id` and `retry` fields are dropped, since replay does not
 * need them. A last event without its closing blank line is kept.
 *
 * @param text - The whole body of an event stream.
 * @returns The events in order.
 */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  // The spec allows \r\n, \n and a bare \r as line endings.
  const blocks = text.replace(/\r\n?/g, "\n").split("\n\n");
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      // One space after the colon belongs to the syntax, not to the value.
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (event === undefined && data.length === 0) continue;
    const parsed: SseEvent = {};
    if (event !== undefined) parsed.event = event;
    if (data.length > 0) {
      const joined = data.join("\n");
      try {
        parsed.data = JSON.parse(joined) as JsonValue;
      } catch {
        parsed.text = joined;
      }
    }
    events.push(parsed);
  }
  return events;
}

/**
 * Writes events back as an event stream, one chunk per event, so a replayed
 * stream reaches the SDK in separate reads like a live one does.
 *
 * @param events - The events to write.
 * @returns One string per event, each ending in a blank line.
 */
export function serializeSse(events: SseEvent[]): string[] {
  return events.map((e) => {
    let out = e.event === undefined ? "" : `event: ${e.event}\n`;
    const payload = e.data !== undefined ? JSON.stringify(e.data) : e.text;
    if (payload !== undefined) {
      // A multi-line payload is several `data:` lines, joined by "\n" on parsing.
      for (const line of payload.split("\n")) out += `data: ${line}\n`;
    }
    return `${out}\n`;
  });
}
