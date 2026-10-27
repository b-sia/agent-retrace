/**
 * Process-wide state shared by every copy of agent-retrace loaded in one
 * process.
 *
 * Node can evaluate the same package more than once: Vitest re-evaluates
 * modules for each test file, and a dependency tree can install the package
 * twice. Module-scope variables would then exist once per copy, so an
 * interceptor installed by copy A would never see sessions started by copy B.
 * Keeping the state on `globalThis` under a `Symbol.for` key gives every copy
 * the same object. (Python caches each module once in `sys.modules`; Go links
 * each package once. Neither has this problem.)
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRetraceConfig } from "./config.js";
import { defaultConfig } from "./defaults.js";

/**
 * Shared state for the whole process.
 */
export interface Runtime {
  /** Carries the active replay session through async calls. */
  als: AsyncLocalStorage<unknown>;
  /** Current configuration, replaced wholesale by `configure()`. */
  config: AgentRetraceConfig;
  /** Recording files used by a running `replay()`, to reject concurrent use. */
  activePaths: Set<string>;
  /** What has been installed into Node globals, so it is installed once. */
  installed: { dispatcher?: object; httpGuard?: boolean };
}

// `Symbol.for` returns the same symbol for the same string across module
// copies and realms in one process, unlike `Symbol()`. The "v1" suffix lets a
// future incompatible shape coexist with this one.
const RUNTIME_KEY = Symbol.for("agent-retrace.runtime.v1");

type RuntimeHolder = { [RUNTIME_KEY]?: Runtime };

/**
 * Returns the process-wide runtime, creating it on first use.
 *
 * @returns The runtime shared by all copies of the library.
 */
export function runtime(): Runtime {
  const holder = globalThis as RuntimeHolder;
  holder[RUNTIME_KEY] ??= {
    als: new AsyncLocalStorage(),
    config: defaultConfig(),
    activePaths: new Set(),
    installed: {},
  };
  return holder[RUNTIME_KEY];
}
