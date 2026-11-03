/**
 * agent-retrace public entry point. Importing it installs the provider call
 * interceptor and the `node:http`/`node:https` guard.
 */
import { installHttpGuard, installInterceptor } from "./http/interceptor.js";

export type { ConfigureOptions, Mode, RedactRule } from "./config.js";
export { configure } from "./config.js";
export * from "./errors.js";
export type {
  JsonValue,
  LlmStep,
  RecordedError,
  RecordedRequest,
  RecordedResponse,
  Recording,
  SseEvent,
  Step,
  ToolOutcome,
  ToolStep,
} from "./recording/format.js";
export type { RecordToolOptions, ReplayOptions } from "./replay.js";
export { recordTool, replay } from "./replay.js";

installInterceptor();
installHttpGuard();
