/**
 * User configuration and mode resolution. The configuration itself lives on
 * the shared runtime object (see `runtime.ts`), not in this module, so every
 * copy of the library sees the same values.
 */
import { DEFAULT_PROVIDER_HOSTS, defaultConfig } from "./defaults.js";
import { InvalidModeError, ReplayUsageError } from "./errors.js";
import { runtime } from "./runtime.js";

export { DEFAULT_PROVIDER_HOSTS };

/** How `replay()` treats recordings. */
export type Mode = "replay" | "auto" | "update";

/**
 * A redaction rule: a pattern whose matches are replaced, or a function that
 * maps a string value to its redacted form.
 */
export type RedactRule = RegExp | ((value: string) => string);

/** The effective configuration. Frozen, so its arrays are read-only. */
export interface AgentRetraceConfig {
  /** Hosts whose calls are recorded and replayed: `host` or `host:port`, lowercase. */
  readonly providerHosts: readonly string[];
  /** Request body paths ignored when matching, e.g. `metadata` or `messages.*.cache_control`. */
  readonly ignore: readonly string[];
  /** Extra redaction rules applied before anything is written to disk. */
  readonly redact: readonly RedactRule[];
}

/** Options accepted by `configure()`. */
export interface ConfigureOptions {
  /** Extra provider hosts, added to the defaults: `host` or `host:port`. */
  providerHosts?: readonly string[];
  /** Request body paths ignored when matching, e.g. `metadata` or `messages.*.cache_control`. */
  ignore?: readonly string[];
  /** Extra redaction rules. */
  redact?: readonly RedactRule[];
}

const MODES: readonly Mode[] = ["replay", "auto", "update"];

// `url.port` is "" when a URL uses its scheme's default port.
const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };

/**
 * Drops the trailing dot of a fully qualified hostname, so "api.openai.com."
 * and "api.openai.com" are the same host, as they are to DNS.
 *
 * @param hostname - A hostname as parsed by `URL`.
 * @returns The hostname without a trailing dot.
 */
function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * Validates a configured provider host and puts it in canonical form: trimmed,
 * lowercase, IDN hostnames in punycode, no trailing dot, port as digits.
 *
 * @param raw - An entry from `configure({ providerHosts })`.
 * @returns The canonical `host` or `host:port`.
 * @throws {ReplayUsageError} When the entry is not a bare `host` or `host:port`.
 */
function normalizeProviderHost(raw: string): string {
  const entry = raw.trim();
  const invalid = () =>
    new ReplayUsageError(
      `Invalid provider host ${JSON.stringify(raw)}. Use "host" or "host:port" without a scheme or path, e.g. "my-gw.example.com" or "127.0.0.1:4010".`,
    );
  let parsed: URL;
  let hostname: string;
  try {
    // A non-special scheme keeps every port as written ("http:" and "https:"
    // would drop 80 and 443), so the shape check sees the port the user gave.
    parsed = new URL(`x://${entry}`);
    // Re-parsing the hostname under "http:" applies the same normalization
    // (punycode, IPv4 forms) that request URLs get.
    hostname = stripTrailingDot(new URL(`http://${parsed.hostname}`).hostname);
  } catch {
    throw invalid();
  }
  const extras = parsed.username || parsed.password || parsed.pathname || parsed.search;
  if (parsed.hostname === "" || hostname === "" || extras || parsed.hash) throw invalid();
  return parsed.port === "" ? hostname : `${hostname}:${parsed.port}`;
}

/**
 * Builds a frozen configuration from the user-supplied values plus defaults.
 *
 * @param opts - User-supplied values.
 * @returns The effective configuration.
 * @throws {ReplayUsageError} When a provider host is malformed.
 */
function buildConfig(opts: ConfigureOptions): AgentRetraceConfig {
  const hosts = [...DEFAULT_PROVIDER_HOSTS, ...(opts.providerHosts ?? [])].map(
    normalizeProviderHost,
  );
  return Object.freeze({
    providerHosts: Object.freeze([...new Set(hosts)]),
    ignore: Object.freeze([...(opts.ignore ?? [])]),
    redact: Object.freeze([...(opts.redact ?? [])]),
  });
}

/**
 * Sets user configuration. Each option given replaces the value from earlier
 * calls, so a setup file that runs once per test file stays idempotent.
 * Options left out keep their current values. Default provider hosts always
 * stay. A call that throws leaves the configuration unchanged.
 *
 * @param opts - Values to set.
 * @throws {ReplayUsageError} When a provider host is not a bare `host` or `host:port`.
 */
export function configure(opts: ConfigureOptions): void {
  const rt = runtime();
  const current = rt.config;
  rt.config = buildConfig({
    providerHosts: opts.providerHosts ?? current.providerHosts,
    ignore: opts.ignore ?? current.ignore,
    redact: opts.redact ?? current.redact,
  });
}

/**
 * Returns the effective configuration.
 *
 * @returns The current configuration, frozen.
 */
export function getConfig(): Readonly<AgentRetraceConfig> {
  return runtime().config;
}

/**
 * Restores the default configuration. For tests only, not part of the public API.
 */
export function resetConfig(): void {
  runtime().config = defaultConfig();
}

/**
 * Reports whether an environment flag is set. Empty, "0" and "false" (any
 * case) count as unset, matching how CI providers and users write it.
 *
 * @param value - The variable's value.
 * @returns True when the flag is set.
 */
function isFlagSet(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());
}

/**
 * Resolves the mode from `AGENT_RETRACE_MODE`, falling back to `replay` on CI
 * and `auto` locally. An empty `AGENT_RETRACE_MODE` counts as unset.
 *
 * @param env - Environment to read, `process.env` by default.
 * @returns The resolved mode.
 * @throws {InvalidModeError} When `AGENT_RETRACE_MODE` is not a valid mode.
 */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): Mode {
  const value = env.AGENT_RETRACE_MODE;
  if (value !== undefined && value !== "") {
    if (!(MODES as readonly string[]).includes(value)) throw new InvalidModeError(value);
    return value as Mode;
  }
  return isFlagSet(env.CI) ? "replay" : "auto";
}

/**
 * Reports whether a URL points at a provider host. A configured host without
 * a port matches that hostname on any port; one with a port matches only that
 * `host:port`, including the scheme's default port ("host:443" matches
 * "https://host/").
 *
 * @param url - The request URL.
 * @returns True when calls to this URL are recorded and replayed.
 */
export function isProviderHost(url: URL): boolean {
  // URL lowercases hostnames and drops default ports, so the default port is
  // restored here before comparing against "host:port" entries.
  const hostname = stripTrailingDot(url.hostname);
  const port = url.port || DEFAULT_PORTS[url.protocol];
  return getConfig().providerHosts.some(
    (entry) => entry === hostname || (port !== undefined && entry === `${hostname}:${port}`),
  );
}
