/**
 * User configuration and mode resolution. The configuration itself lives on
 * the shared runtime object (see `runtime.ts`), not in this module, so every
 * copy of the library sees the same values.
 */
import { InvalidModeError } from "./errors.js";
import { runtime } from "./runtime.js";

/** How `replay()` treats recordings. */
export type Mode = "replay" | "auto" | "update";

/**
 * A redaction rule: a pattern whose matches are replaced, or a function that
 * maps a string value to its redacted form.
 */
export type RedactRule = RegExp | ((value: string) => string);

/** The effective configuration. */
export interface AgentRetraceConfig {
  /** Hosts whose calls are recorded and replayed: `host` or `host:port`, lowercase. */
  providerHosts: string[];
  /** Request paths ignored when matching, e.g. `body.metadata`. */
  ignore: string[];
  /** Extra redaction rules applied before anything is written to disk. */
  redact: RedactRule[];
}

/** Options accepted by `configure()`. */
export interface ConfigureOptions {
  /** Extra provider hosts, added to the defaults. */
  providerHosts?: string[];
  /** Request paths ignored when matching. */
  ignore?: string[];
  /** Extra redaction rules. */
  redact?: RedactRule[];
}

/** Provider hosts that are always recorded and replayed. */
export const DEFAULT_PROVIDER_HOSTS: readonly string[] = Object.freeze([
  "api.openai.com",
  "api.anthropic.com",
]);

const MODES: readonly Mode[] = ["replay", "auto", "update"];

/**
 * Builds a frozen configuration from the user-supplied values plus defaults.
 *
 * @param opts - User-supplied values.
 * @returns The effective configuration.
 */
function buildConfig(opts: ConfigureOptions): AgentRetraceConfig {
  const hosts = [...DEFAULT_PROVIDER_HOSTS, ...(opts.providerHosts ?? [])].map((h) =>
    h.toLowerCase(),
  );
  return Object.freeze({
    providerHosts: Object.freeze([...new Set(hosts)]) as string[],
    ignore: Object.freeze([...(opts.ignore ?? [])]) as string[],
    redact: Object.freeze([...(opts.redact ?? [])]) as RedactRule[],
  });
}

/**
 * Returns the configuration in effect before any `configure()` call.
 *
 * @returns The default configuration.
 */
export function defaultConfig(): AgentRetraceConfig {
  return buildConfig({});
}

/**
 * Sets user configuration. Each option given replaces the value from earlier
 * calls, so a setup file that runs once per test file stays idempotent.
 * Options left out keep their current values. Default provider hosts always
 * stay.
 *
 * @param opts - Values to set.
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
 * `host:port`.
 *
 * @param url - The request URL.
 * @param config - Configuration to check against, the current one by default.
 * @returns True when calls to this URL are recorded and replayed.
 */
export function isProviderHost(url: URL, config: AgentRetraceConfig = getConfig()): boolean {
  // URL lowercases hostnames and drops default ports (443 for https), so
  // `url.host` is "api.openai.com" for "https://API.openai.com:443/".
  return config.providerHosts.some((entry) => entry === url.hostname || entry === url.host);
}
