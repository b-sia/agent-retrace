/**
 * Request normalization: redaction, secret scrubbing, ignore paths, match keys
 * and conversion of tool arguments to JSON. Pure, no I/O.
 */
import type { AgentRetraceConfig, RedactRule } from "../config.js";
import { ReplayUsageError } from "../errors.js";
import { type JsonValue, type RecordedRequest, stableStringify } from "../recording/format.js";

/** Request headers that take part in matching and are stored. All others are dropped. */
export const MATCHED_REQUEST_HEADERS: readonly string[] = Object.freeze([
  "anthropic-beta",
  "anthropic-version",
  "openai-beta",
]);

/** Response headers that are stored and replayed. All others are dropped. */
export const KEPT_RESPONSE_HEADERS: readonly string[] = Object.freeze([
  "content-type",
  "request-id",
  "x-request-id",
]);

/** Request headers whose values are credentials. */
export const SECRET_HEADERS: readonly string[] = Object.freeze([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
]);

/** What redacted text and scrubbed secrets are replaced with. */
export const REDACTED = "[REDACTED]";

// Shorter values ("abc", "1") would turn up by chance in ordinary text, so
// scrubbing them would mangle recordings without protecting anything.
const MIN_SECRET_LENGTH = 8;

/**
 * Rebuilds a JSON value with every string value passed through `map`.
 *
 * @param value - The value to walk.
 * @param map - Applied to every string value.
 * @param mapKeys - Whether object keys are mapped too.
 * @returns A new value; the input is not changed.
 */
function mapStrings(value: JsonValue, map: (s: string) => string, mapKeys: boolean): JsonValue {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map, mapKeys));
  if (value === null || typeof value !== "object") return value;
  const out: { [k: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    out[mapKeys ? map(key) : key] = mapStrings(item, map, mapKeys);
  }
  return out;
}

/**
 * Turns a redaction rule into a string function.
 *
 * @param rule - A pattern or a function.
 * @returns A function that redacts one string.
 */
function ruleToFunction(rule: RedactRule): (s: string) => string {
  if (typeof rule === "function") return rule;
  // A copy with the g flag replaces every match. Copying also leaves the
  // user's regex alone: a g-flagged RegExp is stateful (`lastIndex`), unlike
  // a compiled pattern in Python or Go. The y (sticky) flag is dropped: with
  // it, `replace` only matches at index 0 and right after a previous match,
  // so text anywhere else would reach disk unredacted.
  const flags = rule.flags.replace("y", "");
  const pattern = new RegExp(rule.source, flags.includes("g") ? flags : `${flags}g`);
  return (s) => s.replace(pattern, REDACTED);
}

/**
 * Applies redaction rules, in order, to every string value in a JSON value.
 * Object keys are left alone so the structure of a request stays intact.
 *
 * @param value - The value to redact.
 * @param rules - Patterns, whose every match becomes `REDACTED`, or functions
 *   that map the whole string.
 * @returns A new, redacted value; the input is not changed.
 */
export function redactDeep(value: JsonValue, rules: readonly RedactRule[]): JsonValue {
  if (rules.length === 0) return value;
  const fns = rules.map(ruleToFunction);
  return mapStrings(value, (s) => fns.reduce((acc, fn) => fn(acc), s), false);
}

/**
 * Escapes a string for literal use inside a regular expression.
 *
 * @param s - Any string.
 * @returns The string with every regex metacharacter escaped.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every occurrence of each secret with `REDACTED`, in string values
 * and object keys alike, since a leaked key is never acceptable. Secrets
 * shorter than 8 characters are ignored.
 *
 * All secrets are replaced in one pass, longest first, so a secret that
 * contains another is removed whole and replacement text is never rescanned.
 *
 * @param value - The value to scrub.
 * @param secrets - Literal secret strings.
 * @returns A new, scrubbed value, or the input itself when no secret is long enough.
 */
export function scrubSecrets<T extends JsonValue>(value: T, secrets: readonly string[]): T {
  const usable = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH);
  if (usable.length === 0) return value;
  usable.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(usable.map(escapeRegExp).join("|"), "g");
  return mapStrings(value, (s) => s.replace(pattern, REDACTED), true) as T;
}

/**
 * Collects the credentials found in request headers: the value of every
 * header in `SECRET_HEADERS` and, for `<scheme> <token>` values such as
 * "Bearer sk-...", the token on its own too. Header names match in any case.
 *
 * @param headers - Request headers as sent.
 * @returns The secrets, deduplicated, in header order.
 */
export function secretsFromHeaders(headers: Record<string, string>): string[] {
  const secrets = new Set<string>();
  for (const [name, raw] of Object.entries(headers)) {
    if (!SECRET_HEADERS.includes(name.toLowerCase())) continue;
    const value = raw.trim();
    if (value === "") continue;
    secrets.add(value);
    const token = /^[A-Za-z][\w-]*\s+(\S+)$/.exec(value)?.[1];
    if (token !== undefined) secrets.add(token);
  }
  return [...secrets];
}

/**
 * Parses an array index segment.
 *
 * @param segment - One path segment.
 * @returns The index, or undefined when the segment is not a canonical non-negative integer.
 */
function arrayIndex(segment: string): number | undefined {
  return /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : undefined;
}

/**
 * Removes one path from a value.
 *
 * @param value - The value to walk.
 * @param segments - Remaining path segments; `*` matches every key or index.
 * @returns A new value without the path, or the input when the path does not exist.
 */
function removePath(value: JsonValue, segments: readonly string[]): JsonValue {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  const last = rest.length === 0;
  if (Array.isArray(value)) {
    if (head === "*") return last ? [] : value.map((item) => removePath(item, rest));
    const index = arrayIndex(head);
    if (index === undefined || index >= value.length) return value;
    if (last) return value.filter((_, i) => i !== index);
    return value.map((item, i) => (i === index ? removePath(item, rest) : item));
  }
  if (value === null || typeof value !== "object") return value;
  // `Object.hasOwn` rather than `head in value`, so "constructor" or
  // "toString" are not found on the prototype.
  if (head !== "*" && !Object.hasOwn(value, head)) return value;
  const out: { [k: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (head !== "*" && key !== head) out[key] = item;
    else if (!last) out[key] = removePath(item, rest);
  }
  return out;
}

/**
 * Removes dot paths from a value, e.g. "metadata" or "messages.*.cache_control".
 * A `*` segment matches every key or array index at that level, and a numeric
 * segment selects one array element. A path that does not exist is a no-op.
 * Keys containing "." cannot be addressed.
 *
 * @param value - The value to clean.
 * @param paths - Dot paths to remove.
 * @returns A new value without those paths; the input is not changed.
 */
export function removeIgnoredPaths(value: JsonValue, paths: readonly string[]): JsonValue {
  return paths
    .filter((path) => path !== "")
    .reduce((acc, path) => removePath(acc, path.split(".")), value);
}

/**
 * Computes the key under which an LLM request matches its recording: method,
 * URL (query string included, since e.g. Azure's `api-version` matters),
 * headers, and the body without `config.ignore` paths (or the raw text).
 * Requests are expected to be captured, so already redacted and filtered.
 *
 * @param req - A captured or recorded request.
 * @param config - Configuration supplying the ignore paths.
 * @returns A string that is equal for two requests exactly when they match.
 */
export function llmMatchKey(req: RecordedRequest, config: AgentRetraceConfig): string {
  const key: Record<string, JsonValue> = {
    method: req.method,
    url: req.url,
    headers: req.headers,
  };
  if (req.body !== undefined) key.body = removeIgnoredPaths(req.body, config.ignore);
  else if (req.text !== undefined) key.text = req.text;
  return stableStringify(key);
}

/**
 * Computes the key under which a tool call matches its recording.
 *
 * @param name - Tool name.
 * @param args - Arguments, already converted with `toJsonArgs`.
 * @returns A string that is equal for two calls exactly when they match.
 */
export function toolMatchKey(name: string, args: readonly JsonValue[]): string {
  return stableStringify({ name, args });
}

/**
 * Appends a property key to a path in JavaScript accessor syntax.
 *
 * @param path - Path so far, e.g. "args[0]".
 * @param key - Property name.
 * @returns E.g. "args[0].query" or `args[0]["a b"]`.
 */
function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Reports whether a value is left out of an object (and written as null in
 * an array): undefined, functions, symbols, and `AbortSignal`s, which the
 * Vercel AI SDK passes to every tool.
 *
 * @param value - A property or element value, after `toJSON`.
 * @returns True when the value is dropped.
 */
function isDropped(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    value instanceof AbortSignal
  );
}

/**
 * Reports whether an object is a plain object: made by `{}`, `Object.create(null)`
 * or `JSON.parse`, possibly in another realm (vm context, worker).
 *
 * @param value - Any object.
 * @returns True when its prototype is null or some realm's `Object.prototype`.
 */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Converts one value to JSON, like `JSON.parse(JSON.stringify(value))` but
 * with errors that name the offending path.
 *
 * @param value - The value to convert.
 * @param path - Where the value sits, for error messages.
 * @param ancestors - Objects currently being converted, to detect cycles.
 * @returns The JSON value, or undefined when the value is dropped.
 * @throws {ReplayUsageError} On a bigint, a circular reference, or an object
 *   that JSON would write as {} (see `toJsonValue`).
 */
function convert(value: unknown, path: string, ancestors: Set<object>): JsonValue | undefined {
  if (value !== null && typeof value === "object" && !(value instanceof AbortSignal)) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    // Date defines toJSON, which returns its ISO string.
    if (typeof toJSON === "function") value = toJSON.call(value);
  }
  // Boxed primitives (`new String("a")`) are unwrapped, as JSON.stringify does.
  if (value instanceof String || value instanceof Number || value instanceof Boolean) {
    value = value.valueOf();
  }
  if (isDropped(value)) return undefined;
  if (typeof value === "bigint") {
    throw new ReplayUsageError(
      `${path} is a bigint, which JSON cannot store. Convert it to a string or number.`,
    );
  }
  // NaN and Infinity become null, and -0 becomes 0, as in JSON.
  if (typeof value === "number") return Number.isFinite(value) ? value + 0 : null;
  if (value === null || typeof value !== "object") return value as string | boolean | null;
  // JSON.stringify writes {} for a Map, a Set, an Error, a Promise or any
  // other object whose data is not in own enumerable properties, so two
  // different ones would match. A Map or Set with extra properties set on it
  // would still lose its entries, so those two are always rejected.
  if (
    value instanceof Map ||
    value instanceof Set ||
    (!Array.isArray(value) && !isPlainObject(value) && Object.keys(value).length === 0)
  ) {
    const name = Object.getPrototypeOf(value)?.constructor?.name || "object";
    throw new ReplayUsageError(
      `${path} is a ${name}, which JSON writes as {}. Convert it to an array, a string or a plain object.`,
    );
  }
  if (ancestors.has(value)) {
    throw new ReplayUsageError(`${path} is a circular reference, which JSON cannot store.`);
  }
  ancestors.add(value);
  let out: JsonValue;
  if (Array.isArray(value)) {
    // `Array.from` visits sparse-array holes, which `map` would skip.
    out = Array.from(value, (item, i) => convert(item, `${path}[${i}]`, ancestors) ?? null);
  } else {
    const record: { [k: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = convert(item, childPath(path, key), ancestors);
      if (converted !== undefined) record[key] = converted;
    }
    out = record;
  }
  ancestors.delete(value);
  return out;
}

/**
 * Converts a value to JSON with `JSON.stringify` semantics: `toJSON` is
 * honored (a Date becomes its ISO string), boxed primitives are unwrapped,
 * and undefined, functions, symbols and `AbortSignal`s are dropped. Used for
 * tool return values.
 *
 * @param value - The value to convert.
 * @param path - Name of the value in error messages, e.g. "return value".
 * @returns The JSON value; a dropped value becomes null.
 * @throws {ReplayUsageError} On a bigint, a circular reference, a Map, a Set,
 *   or any other non-plain object with no own enumerable properties (an Error,
 *   a RegExp, a Promise, an empty class instance), which JSON would write as
 *   {}. The message names the path to it.
 */
export function toJsonValue(value: unknown, path: string): JsonValue {
  return convert(value, path, new Set()) ?? null;
}

/**
 * Converts tool arguments to JSON so they can be matched and stored. Dropped
 * values are omitted from objects and become null in arrays, including the
 * argument list itself, exactly as `JSON.stringify` does.
 *
 * @param args - Arguments the tool was called with.
 * @returns One JSON value per argument.
 * @throws {ReplayUsageError} On a value `toJsonValue` rejects, naming the
 *   path to it, e.g. "args[1].items[0].n".
 */
export function toJsonArgs(args: readonly unknown[]): JsonValue[] {
  return Array.from(args, (arg, i) => toJsonValue(arg, `args[${i}]`));
}
