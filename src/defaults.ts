/**
 * Default configuration values. This module imports nothing at runtime, so
 * both `runtime.ts` and `config.ts` can depend on it without importing each
 * other.
 */
import type { AgentRetraceConfig } from "./config.js";

/** Provider hosts that are always recorded and replayed. */
export const DEFAULT_PROVIDER_HOSTS: readonly string[] = Object.freeze([
  "api.openai.com",
  "api.anthropic.com",
]);

/**
 * Returns the configuration in effect before any `configure()` call.
 *
 * @returns The default configuration, frozen.
 */
export function defaultConfig(): AgentRetraceConfig {
  return Object.freeze({
    providerHosts: DEFAULT_PROVIDER_HOSTS,
    ignore: Object.freeze([]),
    redact: Object.freeze([]),
  });
}
