/**
 * JSON value types and the type guards every module that reads recorded JSON
 * shares. Pure, no I/O.
 */

/** Any value that survives a JSON round trip unchanged. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [k: string]: JsonValue };

/**
 * Reports whether a value is a plain object (not null, not an array).
 *
 * @param value - Any value; a JSON value narrows to {@link JsonObject}.
 * @returns True for objects.
 */
export function isObject(value: JsonValue | undefined): value is JsonObject;
export function isObject(value: unknown): value is Record<string, unknown>;
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a value as an array, or an empty array when it is not one.
 *
 * @param value - Any JSON value.
 * @returns The array.
 */
export function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Returns a value when it is a string.
 *
 * @param value - Any JSON value.
 * @returns The string, or undefined.
 */
export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
