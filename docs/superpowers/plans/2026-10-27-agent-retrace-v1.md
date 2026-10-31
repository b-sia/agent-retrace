# agent-retrace v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `agent-retrace`, a TypeScript library that records LLM and tool calls made inside a test, replays them offline, and on a change reports "Your agent changed at step N of M" with a readable semantic diff, plus an update mode that re-records only from the changed step.

**Architecture:** Provider HTTP calls are intercepted by wrapping Node's global undici dispatcher (read per request, so SDK clients built before the test still get intercepted). `replay(name, fn)` runs `fn` inside an `AsyncLocalStorage` session that decides, per request or wrapped tool call, whether to replay a recorded step, go live and record, or fail with a change report. Pure modules (format, normalization, semantic diff, session state machine) sit under thin I/O layers (store, interceptor, public API), so most logic is unit-tested without sockets.

**Tech Stack:** Node.js >=22, TypeScript 7 (`tsc`, strict, ESM), Vitest 5, `node:test`, Biome 2, lefthook, GitHub Actions. Runtime deps: `undici@^7` (fallback dispatcher only), `diff@^9` (line/array diffs), `picocolors@^1` (terminal color). Dev deps: `openai@^7`, `@anthropic-ai/sdk@^1`, `ai@^7`, `@ai-sdk/openai@^4`, `@ai-sdk/anthropic@^4`, `publint`, `@arethetypeswrong/cli`.

**Spec:** `docs/superpowers/specs/2026-10-26-agent-replay-design.md` (read it before starting any task; this plan argues from it).

## Global Constraints

- Package, CLI binary and repo name: `agent-retrace`. GitHub owner `b-sia`. MIT license, copyright holder "b-sia".
- `engines.node` is `">=22"`. CI matrix: Node 22, 24, 26.
- Published as ESM (`"type": "module"`) with `.d.ts` files. No runtime dependency on any AI SDK.
- TypeScript strict mode, plus `noUncheckedIndexedAccess`.
- Every function, method and class has a JSDoc comment: purpose, `@param`, `@returns`, `@throws` where applicable.
- Never use the em dash character anywhere (code, comments, docs, messages, commit messages). Use "-".
- Commit messages: conventional commits, and never a `Co-Authored-By` line naming the coding agent (owner's rule overrides any harness default).
- Comments where Node behaves differently from Python/Go; one short `docs/learning/<topic>.md` note per module explaining the Node concepts it uses.
- Mode env var: `AGENT_RETRACE_MODE` in `replay | auto | update`. Default `replay` when `CI` is set, `auto` otherwise.
- Default provider hosts: `api.openai.com`, `api.anthropic.com`. User-configured hosts are additive and treated identically.
- Recordings live in `__recordings__/<name>.json` next to the test file, are pretty-printed (2 spaces, trailing newline), have stable key order, and carry `formatVersion: 1`.
- Auth headers and API keys never appear in a recording file.
- Work on branch `feat/agent-retrace-v1` (created in Task 1).

## Review Focus

1. **Two copies of the library in one process** (Vitest re-evaluates modules per test file; a package can also be installed twice). Expected: the interceptor installed by copy A still finds sessions started by copy B. Pinned by the runtime singleton test in Task 6.
2. **Something else replaces the global dispatcher after import** (msw, nock, a `ProxyAgent`, another `setGlobalDispatcher`). Expected: `replay()` re-installs on top of it, so provider calls are still intercepted and in CI still blocked. Pinned by the re-install test in Task 8.
3. **Compressed live responses** (gzip/br from the provider or a gateway). Expected: the recording stores decoded, readable JSON/SSE, and replay serves it without `content-encoding`. Pinned by the gzip test in Task 7.
4. **Transient errors during recording** (429/5xx followed by an SDK retry). Expected: the transient response is not recorded, and replay is one clean call with no retry delay. Pinned by the `failFirst` test in Task 9.
5. **Agent code that catches the SDK error on a mismatch** (try/catch around the model call, fallback answer). Expected: `replay()` still rejects with `ChangeDetectedError`, so the test cannot pass silently. Pinned by the swallowed-error test in Task 8.

---

## File Structure

```
package.json, tsconfig.json, tsconfig.build.json, biome.json, lefthook.yml, vitest.config.ts, LICENSE, README.md
.github/workflows/ci.yml
src/
  index.ts              public exports; installs interceptor + http guard on import
  errors.ts             error classes
  runtime.ts            process-wide singleton on globalThis (ALS, config, active paths)
  defaults.ts           DEFAULT_PROVIDER_HOSTS, defaultConfig() (leaf module, breaks the config/runtime cycle)
  config.ts             configure(), getConfig(), resolveMode(), isProviderHost()
  recording/format.ts   types, FORMAT_VERSION, stableStringify, serialize/parse
  recording/store.ts    name validation, path resolution, caller test file, load/save
  match/normalize.ts    redaction, secret scrubbing, ignore paths, match keys, toJsonArgs
  diff/semantic.ts      provider-specific request -> SemanticRequest
  diff/render.ts        ChangeReport -> readable text
  diff/command.ts       re-record command
  session.ts            per-replay state machine (strict / record / update)
  http/sse.ts           parse/serialize text/event-stream
  http/capture.ts       dispatcher opts/bytes -> RecordedRequest/RecordedResponse; encode for replay
  http/handler.ts       undici handler adapter (legacy + new API), tee handler
  http/interceptor.ts   global dispatcher wrapper, http/https guard
  replay.ts             replay() and recordTool()
  cli.ts                `agent-retrace inspect <file>`
test/unit/*.test.ts, test/integration/*.test.ts, test/sdk/*.test.ts, test/node-test/*.test.mjs
test/support/fake-provider.ts, test/support/http-server.ts
examples/support-agent/{agent.ts,tools.ts,agent.test.ts,__recordings__/}
docs/learning/*.md, docs/demo/demo.tape, docs/demo/demo.gif
```

---

### Task 1: Repository scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `lefthook.yml`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `.github/workflows/ci.yml`, `src/index.ts`, `test/unit/smoke.test.ts`, `docs/learning/esm-and-packaging.md`

**Interfaces:**
- Produces: npm scripts used by every later task: `build`, `typecheck`, `lint`, `format`, `test`, `test:node`, `test:example`, `check:package`, `ci`.

- [x] **Step 1: Initialize git**

```bash
git init -b main && git add docs && git commit -m "docs: add v1 design spec and implementation plan"
git switch -c feat/agent-retrace-v1
```

- [x] **Step 2: Write `package.json`**

Fields: `name: "agent-retrace"`, `version: "0.1.0"`, `type: "module"`, `license: "MIT"`, `engines: {"node": ">=22"}`, `exports: {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}}`, `bin: {"agent-retrace": "./dist/cli.js"}`, `files: ["dist"]`, `repository` pointing at `github.com/b-sia/agent-retrace`, `keywords` (llm, agent, testing, record, replay, vcr, openai, anthropic). Scripts:

| script | command |
|---|---|
| `build` | `tsc -p tsconfig.build.json` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` |
| `lint` | `biome check .` |
| `format` | `biome check --write .` |
| `test` | `vitest run --project unit` |
| `test:node` | `npm run build && node --test test/node-test/` |
| `test:example` | `npm run build && vitest run --project example` |
| `check:package` | `npm run build && publint && attw --pack . --profile esm-only` |
| `ci` | `npm run lint && npm run typecheck && npm test && npm run test:node && npm run test:example && npm run check:package` |
| `prepare` | `lefthook install` |

Install exact current majors: runtime `undici@^7 diff@^9 picocolors@^1`; dev `typescript@^7 vitest@^5 @biomejs/biome@^2 lefthook@^2 @types/node@^22 publint @arethetypeswrong/cli openai@^7 @anthropic-ai/sdk@^1 ai@^7 @ai-sdk/openai@^4 @ai-sdk/anthropic@^4`. Use `undici@^7`, not 8: undici 8 requires Node >=22.19, which would break `engines >=22`.

- [x] **Step 3: Write configs**

- `tsconfig.json`: `module`/`moduleResolution` `nodenext`, `target` `es2023`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `skipLibCheck`, includes `src`, `test`, `examples`, `vitest.config.ts`.
- `tsconfig.build.json`: extends it, `include: ["src"]`, `outDir: "dist"`, `rootDir: "src"`, `declaration`, `sourceMap`, `declarationMap`.
- `biome.json`: recommended rules, formatter indent 2 spaces, line width 100, ignore `dist`, `**/__recordings__`, `docs/demo`.
- `lefthook.yml`: `pre-commit` runs `npx biome check --write --no-errors-on-unmatched {staged_files}` with `stage_fixed: true`.
- `vitest.config.ts`: two projects: `unit` (`include: ["test/**/*.test.ts"]`) and `example` (`root: "examples/support-agent"`, `include: ["**/*.test.ts"]`).
- `.gitignore`: `node_modules`, `dist`, `*.tgz`, `coverage`.
- `LICENSE`: MIT, year 2026, "b-sia".

- [x] **Step 4: Write `.github/workflows/ci.yml`**

Job `test` on `push` and `pull_request`, matrix `node: [22, 24, 26]`, `actions/setup-node` with npm cache, then `npm ci`, `npx biome ci .`, `npm run typecheck`, `npm test`, `npm run test:node`, `npm run check:package`. No API key secrets are exposed to any job. Task 12 adds the offline example job.

- [x] **Step 5: Smoke test**

`test/unit/smoke.test.ts`: `import * as lib from "../../src/index.js"; expect(typeof lib).toBe("object")`. `src/index.ts`: `export {};` with a file-level JSDoc.

- [x] **Step 6: Verify**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all exit 0, `dist/index.js` and `dist/index.d.ts` exist.

- [x] **Step 7: Learning note** `docs/learning/esm-and-packaging.md`: ESM vs CommonJS, `"type": "module"`, the `exports` map, why imports in TS source end in `.js`, `bin` and shebangs, `engines`. Compare with Python packaging / Go modules. Keep it under 80 lines.

- [x] **Step 8: Commit** `chore: scaffold TypeScript ESM package with Biome, Vitest and CI`

---

### Task 2: Errors, runtime singleton and config

**Files:**
- Create: `src/errors.ts`, `src/runtime.ts`, `src/config.ts`, `src/defaults.ts`
- Test: `test/unit/config.test.ts`, `test/unit/runtime.test.ts`

**Interfaces:**
- Produces (`src/errors.ts`), each extends `AgentRetraceError extends Error` with `name` set to the class name:
  - `InvalidModeError(value: string)`, message lists the three valid values.
  - `InvalidRecordingNameError(name: string)`
  - `RecordingFormatError(filePath: string, reason: string)`
  - `RecordingNotFoundError(recordingName: string, filePath: string, command: string)`
  - `ChangeDetectedError(report: string, info: { recordingName: string; stepNumber: number; totalSteps: number }, options?: { cause?: unknown })`, message is `report`.
  - `ProviderCallBlockedError(url: string, reason: "outside-replay" | "after-replay" | "node-http")`
  - `ReplayUsageError(message: string)`
- Produces (`src/config.ts`):
  - `type Mode = "replay" | "auto" | "update"`
  - `type RedactRule = RegExp | ((value: string) => string)`
  - `interface AgentRetraceConfig { readonly providerHosts: readonly string[]; readonly ignore: readonly string[]; readonly redact: readonly RedactRule[] }` (frozen)
  - `interface ConfigureOptions { providerHosts?: readonly string[]; ignore?: readonly string[]; redact?: readonly RedactRule[] }`
  - `const DEFAULT_PROVIDER_HOSTS = ["api.openai.com", "api.anthropic.com"]`
  - `configure(opts: ConfigureOptions): void`: each call replaces the user-supplied values (idempotent when a setup file runs once per test file); defaults always stay. Throws `ReplayUsageError` for a provider host that is not a bare `host` or `host:port`.
  - `getConfig(): Readonly<AgentRetraceConfig>` (providerHosts = defaults + user, lowercased, deduped)
  - `resetConfig(): void` (tests only, not exported from `index.ts`)
  - `resolveMode(env?: NodeJS.ProcessEnv): Mode`, throws `InvalidModeError`
  - `isProviderHost(url: URL, config?: AgentRetraceConfig): boolean`
- Produces (`src/runtime.ts`):
  - `interface Runtime { als: AsyncLocalStorage<Session>; config: AgentRetraceConfig; activePaths: Set<string>; installed: { dispatcher?: object; httpGuard?: boolean } }` (`Session` is a type-only import from Task 6; until then type it as `unknown` and tighten in Task 6)
  - `runtime(): Runtime` that lazily creates and returns `globalThis[Symbol.for("agent-retrace.runtime.v1")]`. The config in `config.ts` lives in this object, not in module scope.

- [x] **Step 1: Write failing tests**

```ts
// test/unit/config.test.ts
test("explicit mode wins", () => expect(resolveMode({ AGENT_RETRACE_MODE: "update", CI: "true" })).toBe("update"));
test("CI defaults to replay", () => expect(resolveMode({ CI: "1" })).toBe("replay"));
test.each(["", "0", "false", "FALSE"])("CI=%j counts as unset", (ci) => expect(resolveMode({ CI: ci })).toBe("auto"));
test("local defaults to auto", () => expect(resolveMode({})).toBe("auto"));
test("invalid mode throws", () => expect(() => resolveMode({ AGENT_RETRACE_MODE: "record" })).toThrow(InvalidModeError));
test("default provider hosts", () => {
  expect(isProviderHost(new URL("https://api.openai.com/v1/x"))).toBe(true);
  expect(isProviderHost(new URL("https://API.Anthropic.com/v1/messages"))).toBe(true);
  expect(isProviderHost(new URL("http://localhost:3000/"))).toBe(false);
});
test("configured hosts are additive and match host:port", () => {
  configure({ providerHosts: ["my-gw.example.com", "127.0.0.1:4010"] });
  expect(isProviderHost(new URL("https://my-gw.example.com/v1"))).toBe(true);
  expect(isProviderHost(new URL("http://127.0.0.1:4010/v1"))).toBe(true);
  expect(isProviderHost(new URL("http://127.0.0.1:4011/v1"))).toBe(false);
  expect(isProviderHost(new URL("https://api.openai.com/"))).toBe(true);
});
test("configure replaces previous user values", () => {
  configure({ providerHosts: ["a.example"] }); configure({ providerHosts: ["b.example"] });
  expect(getConfig().providerHosts).toEqual(["api.openai.com", "api.anthropic.com", "b.example"]);
});
// afterEach(resetConfig)

// test/unit/runtime.test.ts
test("runtime is shared across module copies", async () => {
  const a = await import("../../src/runtime.js");
  const b = await import("../../src/runtime.js?copy=2");
  expect(a.runtime()).toBe(b.runtime());
});
```

A configured entry without a port matches that hostname on any port. An entry with a port matches only that `host:port`, including the scheme's default port (`host:443` matches `https://host/`). Entries are trimmed, lowercased and punycoded; a trailing dot is ignored on entries and request URLs.

- [x] **Step 2:** Run `npx vitest run test/unit/config.test.ts test/unit/runtime.test.ts`. Expected: FAIL (modules missing).
- [x] **Step 3:** Implement the three files per the Interfaces block.
- [x] **Step 4:** Re-run. Expected: PASS.
- [x] **Step 5: Commit** `feat: add error types, mode resolution and provider host config`

---

### Task 3: Recording format and store

**Files:**
- Create: `src/recording/format.ts`, `src/recording/store.ts`, `docs/learning/fs-and-stack-traces.md`
- Test: `test/unit/format.test.ts`, `test/unit/store.test.ts`

**Interfaces:**
- Produces (`format.ts`):
  ```ts
  export const FORMAT_VERSION = 1;
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
  export interface RecordedRequest { method: string; url: string; headers: Record<string, string>; body?: JsonValue; text?: string }
  export interface SseEvent { event?: string; data?: JsonValue; text?: string }   // data = parsed JSON, text = raw non-JSON data
  export interface RecordedResponse { status: number; headers: Record<string, string>; body?: JsonValue; text?: string; events?: SseEvent[] } // exactly one of body/text/events
  export interface LlmStep { type: "llm"; request: RecordedRequest; response: RecordedResponse }
  export type ToolOutcome = { type: "return"; value?: JsonValue } | { type: "throw"; name: string; message: string };
  export interface ToolStep { type: "tool"; name: string; args: JsonValue[]; outcome: ToolOutcome }
  export type Step = LlmStep | ToolStep;
  export interface Recording { formatVersion: 1; name: string; steps: Step[] }
  export function stableStringify(value: unknown): string;
  export function serializeRecording(r: Recording): string;
  export function parseRecording(text: string, filePath: string): Recording; // throws RecordingFormatError
  ```
- Produces (`store.ts`):
  ```ts
  export function validateRecordingName(name: string): void;              // throws InvalidRecordingNameError
  export function recordingsDirFor(testFile: string): string;             // <dirname>/__recordings__
  export function recordingPath(dir: string, name: string): string;       // <dir>/<name>.json
  export function callerTestFile(): string | undefined;
  export function loadRecording(path: string, expectedName: string): Promise<Recording | undefined>; // undefined on ENOENT
  export function saveRecording(path: string, r: Recording): Promise<void>;
  ```

Decisions:
- `stableStringify` key order: keys found in `KEY_PRIORITY = ["formatVersion", "name", "type", "steps", "method", "url", "status", "headers", "request", "response", "args", "outcome", "value", "message", "event", "data", "text", "body", "events"]` come first in that order, then the remaining keys alphabetically. Arrays keep their order. 2-space indent, trailing `\n`.
- `parseRecording` throws `RecordingFormatError` for invalid JSON, a missing or non-integer `formatVersion`, a `formatVersion` greater than 1 (reason says "written by a newer agent-retrace, upgrade the package"), or a step with an unknown `type`.
- Valid names match `/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/`, are at most 120 characters, and do not end with `.` or a space. No slugging, so two names never collide silently.
- `loadRecording` throws `RecordingFormatError` when the stored `name` differs from `expectedName` (catches case-insensitive filesystem collisions such as `Foo`/`foo`).
- `saveRecording`: `mkdir -p`, write to `<path>.<pid>.<random>.tmp`, then `rename` (atomic on POSIX, so an interrupted run never leaves half a file).
- `callerTestFile`: temporarily set `Error.prepareStackTrace` to return V8 `CallSite[]`, capture, and restore in `finally`. Return the first frame whose `getFileName()` is not under this package's own `src`/`dist` directory (derive it from `import.meta.url`), not `node:`-prefixed and not under `node_modules`. Strip the `file://` scheme (`fileURLToPath`) and any `?query`. `getCallSites` from `node:util` cannot be used because it needs Node 22.9+.

- [x] **Step 1: Write failing tests**

```ts
// format.test.ts
test("stable key order and formatting", () => {
  const r: Recording = { steps: [{ type: "tool", outcome: { type: "return", value: { z: 1, a: 2 } }, args: [], name: "s" }], name: "n", formatVersion: 1 } as Recording;
  expect(serializeRecording(r)).toBe(
`{
  "formatVersion": 1,
  "name": "n",
  "steps": [
    {
      "name": "s",
      "type": "tool",
      "args": [],
      "outcome": {
        "type": "return",
        "value": {
          "a": 2,
          "z": 1
        }
      }
    }
  ]
}
`);
});
test("round trip", () => expect(parseRecording(serializeRecording(sample), "f")).toEqual(sample));
test.each([["not json"], ['{"name":"n","steps":[]}'], ['{"formatVersion":2,"name":"n","steps":[]}'], ['{"formatVersion":1,"name":"n","steps":[{"type":"x"}]}']])(
  "rejects %s", (t) => expect(() => parseRecording(t, "f.json")).toThrow(RecordingFormatError));
test("newer version message", () => expect(() => parseRecording('{"formatVersion":2,"name":"n","steps":[]}', "f")).toThrow(/upgrade/));

// store.test.ts
test.each(["", "../x", "a/b", "a\\b", ".hidden", "x.", "-x"])("invalid name %j", (n) => expect(() => validateRecordingName(n)).toThrow(InvalidRecordingNameError));
test.each(["refund-damaged-order", "Refund 2", "v1.2_case"])("valid name %j", (n) => expect(() => validateRecordingName(n)).not.toThrow());
test("callerTestFile returns this test file", () => expect(callerTestFile()).toBe(fileURLToPath(import.meta.url)));
test("load missing returns undefined", async () => expect(await loadRecording(join(tmp, "nope.json"), "nope")).toBeUndefined());
test("save then load", async () => { await saveRecording(p, sample); expect(await loadRecording(p, sample.name)).toEqual(sample); });
test("save leaves no tmp files", async () => { await saveRecording(p, sample); expect(readdirSync(dirname(p))).toEqual([basename(p)]); });
test("name mismatch in file is an error", async () => { await saveRecording(p, { ...sample, name: "Other" }); await expect(loadRecording(p, sample.name)).rejects.toThrow(RecordingFormatError); });
```

- [x] **Step 2:** Run `npx vitest run test/unit/format.test.ts test/unit/store.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement both files.
- [x] **Step 4:** Re-run. Expected: PASS.
- [x] **Step 5: Learning note** `docs/learning/fs-and-stack-traces.md`: `fs/promises`, atomic rename, `import.meta.url` vs `__dirname`, V8 CallSite API.
- [x] **Step 6: Commit** `feat: add recording format and file store`

---

### Task 4: Normalization, redaction and match keys

**Files:**
- Create: `src/match/normalize.ts`
- Test: `test/unit/normalize.test.ts`

**Interfaces:**
- Consumes: `JsonValue`, `RecordedRequest`, `RedactRule`, `AgentRetraceConfig`.
- Produces:
  ```ts
  export const MATCHED_REQUEST_HEADERS = ["anthropic-beta", "anthropic-version", "openai-beta"];
  export const KEPT_RESPONSE_HEADERS = ["content-type", "request-id", "x-request-id"];
  export const SECRET_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie"];
  export const REDACTED = "[REDACTED]";
  export function redactDeep(value: JsonValue, rules: RedactRule[]): JsonValue;   // applies to every string, recursively
  export function scrubSecrets<T extends JsonValue>(value: T, secrets: string[]): T; // replaces every occurrence; ignores secrets shorter than 8 chars
  export function secretsFromHeaders(headers: Record<string, string>): string[];     // values of SECRET_HEADERS, plus the token after "Bearer "
  export function removeIgnoredPaths(value: JsonValue, paths: string[]): JsonValue;
  export function llmMatchKey(req: RecordedRequest, config: AgentRetraceConfig): string;
  export function toolMatchKey(name: string, args: JsonValue[]): string;
  export function toJsonArgs(args: unknown[]): JsonValue[];                           // throws ReplayUsageError
  ```

Decisions:
- A `RegExp` rule replaces every match with `REDACTED` (force the `g` flag on a copy). A function rule maps the whole string.
- Ignore paths are dot paths. A `*` segment matches every key or array index at that level. A missing path is a no-op. Example: `"messages.*.cache_control"`.
- `llmMatchKey` is `stableStringify` of `{ method, url, headers, body | text }`, after `removeIgnoredPaths(body, config.ignore)`. Request bodies are already redacted at capture time (Task 7), so a live request and its recording are compared after the same redaction. The URL keeps its query string, because Azure `api-version` is meaningful.
- `toJsonArgs` drops functions, symbols and `AbortSignal` instances (object properties are omitted, array slots become `null`), and turns `Date` into an ISO string (via `JSON.stringify` replacer semantics). It throws `ReplayUsageError` naming the offending path for a `bigint` or a circular reference. Why: the Vercel AI SDK passes `{ abortSignal, messages, toolCallId }` as the second argument to `execute`.

- [x] **Step 1: Write failing tests**

```ts
test("regex redaction everywhere", () => expect(redactDeep({ a: ["call 555-1234"], b: "555-1234" }, [/\d{3}-\d{4}/])).toEqual({ a: ["call [REDACTED]"], b: "[REDACTED]" }));
test("function redaction", () => expect(redactDeep("Alice", [(s) => s.toUpperCase()])).toBe("ALICE"));
test("scrub secrets", () => expect(scrubSecrets({ x: "key sk-abcdef123456 here" }, ["sk-abcdef123456"])).toEqual({ x: "key [REDACTED] here" }));
test("short secrets ignored", () => expect(scrubSecrets("abc", ["abc"])).toBe("abc"));
test("bearer token extracted", () => expect(secretsFromHeaders({ authorization: "Bearer sk-live-xyz12345" })).toContain("sk-live-xyz12345"));
test("ignore paths with wildcard", () =>
  expect(removeIgnoredPaths({ messages: [{ c: 1, cache_control: 2 }, { c: 3 }], m: 1 }, ["messages.*.cache_control", "nope.x"]))
    .toEqual({ messages: [{ c: 1 }, { c: 3 }], m: 1 }));
test("match key ignores key order and configured paths", () => {
  const cfg = { ...getConfig(), ignore: ["metadata"] };
  const a = { method: "POST", url: "https://api.openai.com/v1/chat/completions", headers: {}, body: { model: "m", messages: [], metadata: { t: 1 } } };
  const b = { ...a, body: { messages: [], model: "m", metadata: { t: 2 } } };
  expect(llmMatchKey(a, cfg)).toBe(llmMatchKey(b, cfg));
  expect(llmMatchKey(a, cfg)).not.toBe(llmMatchKey({ ...a, body: { model: "m2", messages: [] } }, cfg));
});
test("toJsonArgs drops AbortSignal and functions", () =>
  expect(toJsonArgs([{ q: "x" }, { abortSignal: new AbortController().signal, toolCallId: "c1", fn: () => 1 }])).toEqual([{ q: "x" }, { toolCallId: "c1" }]));
test("toJsonArgs rejects circular", () => { const o: any = {}; o.self = o; expect(() => toJsonArgs([o])).toThrow(ReplayUsageError); });
```

- [x] **Step 2:** Run `npx vitest run test/unit/normalize.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Re-run. Expected: PASS.
- [x] **Step 5: Commit** `feat: add request normalization, redaction and match keys`

---

### Task 5: Semantic diff and change report rendering

**Files:**
- Create: `src/diff/semantic.ts`, `src/diff/render.ts`, `src/diff/command.ts`
- Test: `test/unit/semantic.test.ts`, `test/unit/render.test.ts`, `test/unit/command.test.ts`

**Interfaces:**
- Consumes: `Step`, `RecordedRequest`, `JsonValue`, `stableStringify`.
- Produces:
  ```ts
  // semantic.ts
  export type ApiShape = "openai-chat" | "openai-responses" | "anthropic-messages" | "unknown";
  export interface SemanticRequest { api: ApiShape; endpoint: string; model?: string; system: string; messages: string[]; tools: Map<string, JsonValue>; params: Record<string, JsonValue> }
  export function toSemantic(req: RecordedRequest): SemanticRequest;
  // render.ts
  export interface ChangeReport { recordingName: string; recordingPath: string; kind: "changed" | "extra" | "missing"; stepNumber: number; totalSteps: number; recorded?: Step; live?: Step; command: string }
  export function describeStep(step: Step): string; // "LLM call (POST api.openai.com/v1/chat/completions)" | "tool `search`"
  export function renderChange(report: ChangeReport, opts?: { color?: boolean }): string; // color defaults to picocolors.isColorSupported
  // command.ts
  export type Runner = "vitest" | "node-test" | "unknown";
  export function detectRunner(env?: NodeJS.ProcessEnv, execArgv?: string[], argv?: string[]): Runner; // VITEST env -> vitest; "--test" in execArgv/argv -> node-test
  export function rerecordCommand(runner: Runner, testFile: string | undefined, cwd: string): string;
  ```

Decisions:
- API detection is by URL path suffix: `/chat/completions` means openai-chat, `/responses` means openai-responses, `/messages` with an `anthropic-version` header or an Anthropic host means anthropic-messages, anything else is unknown.
- `system`:
  - openai-chat: the content of `system`/`developer` messages joined with `\n`.
  - openai-responses: `instructions` plus `system`/`developer` input items.
  - anthropic: `system` as a string, or its text blocks joined.
- `messages`: every other message, rendered as one line each: `user: <text>`, `assistant: <text>`, `assistant -> tool_call search({"q":"x"})`, `tool_result(<id>): <text>`. Text parts are joined with a space and newlines become `\n` literals. A string `input` in the Responses API is one `user:` line.
- `tools`: name mapped to the schema (openai-chat `function.parameters`, responses `parameters`, anthropic `input_schema`).
- `params`: all remaining top-level body fields except `model`, `messages`, `input`, `instructions`, `system`, `tools`.
- Render order of sections, each printed only if it differs: Endpoint, Model (`model: a -> b`), System prompt (`diffLines`, `-`/`+` prefixed, unchanged lines with 2 spaces, at most 3 lines of context), Messages (`diffArrays` on rendered lines, showing added/removed only, plus a `(N unchanged)` count), Tools (`+ added name`, `- removed name`, `~ changed name (schema)` followed by an indented `diffLines` of the `stableStringify`'d schemas), Params (`~ key: old -> new`, `+ key: v`, `- key: v`). For unknown APIs, a `diffLines` of the `stableStringify`'d bodies. For tool steps: `Tool: name a -> b` and an args `diffLines`.
- Header lines (exact copy):
  - changed: `Your agent changed at step {n} of {total}: {describeStep(recorded)}`
  - extra: `Your agent made more calls than recorded: step {n} is new (recording has {total} steps, "1 step" when total is 1): {describeStep(live)}`
  - missing: `Your agent made fewer calls than recorded: step {n} of {total} was never made: {describeStep(recorded)}`
  - first line before the header: `agent-retrace: recording "{name}" no longer matches.`
- Footer: `Recording: {relative path}` then `To accept this change and re-record from step {n}, run:` then `  {command}`.
- Commands: vitest `AGENT_RETRACE_MODE=update npx vitest run {rel}`, node-test `AGENT_RETRACE_MODE=update node --test {rel}`, unknown or no file `AGENT_RETRACE_MODE=update <your test command>`. `{rel}` is relative to `cwd` with `/` separators.

- [x] **Step 1: Write failing tests**

Build fixtures in `test/unit/fixtures/requests.ts`: one request per API shape (`openaiChat(overrides)`, `openaiResponses(overrides)`, `anthropicMessages(overrides)`).

```ts
test.each([["openai-chat", openaiChat()], ["openai-responses", openaiResponses()], ["anthropic-messages", anthropicMessages()]])(
  "%s: system, messages, tools extracted", (api, req) => {
    const s = toSemantic(req);
    expect(s.api).toBe(api);
    expect(s.system).toBe("You are a support agent.");
    expect(s.messages[0]).toBe("user: My order arrived broken");
    expect([...s.tools.keys()]).toEqual(["lookup_order"]);
    expect(s.params).toEqual({ temperature: 0 });
  });
test("system prompt change renders a line diff, not JSON", () => {
  const out = renderChange(report(openaiChat(), openaiChat({ system: "You are a support agent.\nAlways apologize." })), { color: false });
  expect(out).toContain("Your agent changed at step 2 of 5: LLM call (POST api.openai.com/v1/chat/completions)");
  expect(out).toContain("System prompt:");
  expect(out).toContain("+ Always apologize.");
  expect(out).not.toContain('"messages"');
});
test("tool added and schema changed", () => { /* expects "+ added issue_refund" and "~ changed lookup_order (schema)" */ });
test("param change", () => { /* temperature 0 -> 0.7 expects "~ temperature: 0 -> 0.7" */ });
test("extra and missing headers", () => { /* exact header strings above */ });
test("footer has command", () => expect(out).toContain("  AGENT_RETRACE_MODE=update npx vitest run test/a.test.ts"));
test("detectRunner", () => {
  expect(detectRunner({ VITEST: "true" }, [], [])).toBe("vitest");
  expect(detectRunner({}, ["--test"], [])).toBe("node-test");
  expect(detectRunner({}, [], ["node", "x.js"])).toBe("unknown");
});
```

- [x] **Step 2:** Run `npx vitest run test/unit/semantic.test.ts test/unit/render.test.ts test/unit/command.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement. Use `diffLines` and `diffArrays` from `diff`, and `picocolors` (red for `-`, green for `+`, yellow for `~`, bold header).
- [x] **Step 4:** Re-run. Expected: PASS. Also print one rendered report to the terminal with color on and check it reads well.
- [x] **Step 5: Commit** `feat: add semantic request diff and change report rendering`

---

### Task 6: Session state machine

**Files:**
- Create: `src/session.ts`, `docs/learning/async-context.md`
- Modify: `src/runtime.ts` (type `als` as `AsyncLocalStorage<Session>`)
- Test: `test/unit/session.test.ts`

**Interfaces:**
- Consumes: `Recording`, `Step`, `LlmStep`, `ToolStep`, `RecordedRequest`, `ToolOutcome`, `llmMatchKey`, `toolMatchKey`, `ChangeReport`, `renderChange`, `ChangeDetectedError`.
- Produces:
  ```ts
  export type Strategy = "strict" | "record" | "update";
  export interface SessionOptions {
    name: string; recordingPath: string; strategy: Strategy; recording: Recording | undefined;
    command: string; config: AgentRetraceConfig; save(r: Recording): Promise<void>;
  }
  export type Decision<S extends Step> =
    | { kind: "replay"; step: S }
    | { kind: "live"; commit(step: S | undefined): void }   // undefined = drop (transient error, network failure)
    | { kind: "fail"; error: ChangeDetectedError };
  export class Session {
    constructor(opts: SessionOptions);
    readonly name: string;
    get closed(): boolean;
    decideLlm(request: RecordedRequest): Decision<LlmStep>;
    decideTool(name: string, args: JsonValue[]): Decision<ToolStep>;
    finish(fnError: { error: unknown } | undefined): Promise<void>; // throws
  }
  ```

The algorithm is deterministic and does not depend on completion order:
- Each decision gets a sequence number `seq` when it is made, which is when the request is issued, not when it completes.
- **Match:** the earliest unconsumed recorded step whose match key equals the live key is consumed and replayed. Identical requests consume identical recorded steps in recorded order. Concurrent calls with different keys match regardless of issue order.
- **Comparison target on no match:** the earliest unconsumed step of the same type. For tools, prefer the same name, otherwise the earliest unconsumed tool step. If there is none of the same type, take the earliest unconsumed step of any type. If nothing is unconsumed, the kind is `extra`, with `stepNumber = consumedCount + extraCount + 1`.
- **strict:** a mismatch records the first `ChangeReport` (later ones are ignored) and returns `fail`. `finish` throws, in order: the first mismatch, as a `ChangeDetectedError` whose `cause` is the fn error if any; then the fn error; then, if steps are unconsumed, a `missing` report for the earliest one.
- **record:** every decision is `live`. `finish` saves the committed steps sorted by `seq`, only if there was no fn error.
- **update:** behaves like strict until the first mismatch, then switches to live for that decision and for all later ones, even ones that would match. `finish` with an fn error does not save and rethrows. Otherwise it saves `[consumed recorded steps sorted by original index] + [committed live steps sorted by seq]` when a switch happened or steps are unconsumed (fewer calls). It does not write when nothing changed.
- `finish` sets `closed = true` before saving. Saved steps are not re-redacted here (capture already did it).
- `stepNumber` for `changed` and `missing` is the recorded step's 1-based index. `totalSteps` is `recording.steps.length`.

- [x] **Step 1: Write failing tests**

Helpers: `rec(...steps)`, `llm(id: string)` makes an `LlmStep` whose body is `{ model: "m", messages: [{ role: "user", content: id }] }` with response body `{ id }`, `tool(name, arg)`, and `session(strategy, recording?)` with a `save` spy.

```ts
test("strict replays in order", async () => { /* decideLlm(a), decideTool(t), decideLlm(b) -> replay with matching steps; finish(undefined) resolves; save not called */ });
test("strict tolerates reversed concurrent order", () => { /* recording [a,b]; decide b then a -> both replay with their own responses */ });
test("identical requests consume in recorded order", () => { /* recording [a(resp 1), a(resp 2)] -> first gets 1, second gets 2 */ });
test("changed request fails and reports step", async () => {
  const s = session("strict", rec(llm("a"), llm("b"), llm("c")));
  s.decideLlm(llm("a").request);
  const d = s.decideLlm(llm("B!").request);
  expect(d.kind).toBe("fail");
  await expect(s.finish(undefined)).rejects.toThrow(/changed at step 2 of 3/);
});
test("extra call", async () => { /* recording [a]; decide a, a -> second fails; finish rejects /more calls than recorded: step 2 is new/ */ });
test("fewer calls", async () => { /* recording [a,b,c]; decide a,b; finish rejects /fewer calls than recorded: step 3 of 3/ */ });
test("mismatch wins over fn error and keeps it as cause", async () => { /* finish({error: e}) rejects ChangeDetectedError with cause e */ });
test("fn error rethrown when no mismatch", async () => { /* finish({error:e}) rejects e */ });
test("record saves in issue order regardless of commit order", async () => { /* d1=decide a, d2=decide b; d2.commit(B); d1.commit(A); finish -> save called with steps [A,B] */ });
test("record drops undefined commits", async () => { /* commit(undefined) -> not saved */ });
test("record does not save when fn failed", async () => {});
test("update switches to live at first change and stays live", async () => {
  const s = session("update", rec(llm("a"), tool("t", 1), llm("c"), llm("d")));
  expect(s.decideLlm(llm("a").request).kind).toBe("replay");
  expect(s.decideTool("t", [1]).kind).toBe("replay");
  const d3 = s.decideLlm(llm("c2").request); expect(d3.kind).toBe("live");
  const d4 = s.decideLlm(llm("d").request); expect(d4.kind).toBe("live"); // would match, still live
  (d3 as Live).commit(llm("c2")); (d4 as Live).commit(llm("d"));
  await s.finish(undefined);
  expect(save.mock.calls[0][0].steps).toEqual([llm("a"), tool("t", 1), llm("c2"), llm("d")]);
});
test("update with no change does not write", async () => {});
test("update with fewer calls truncates", async () => { /* recording [a,b,c]; decide a,b -> save [a,b] */ });
test("closed after finish", async () => {});
```

- [x] **Step 2:** Run `npx vitest run test/unit/session.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement `Session`.
- [x] **Step 4:** Re-run. Expected: PASS.
- [x] **Step 5: Learning note** `docs/learning/async-context.md`: `AsyncLocalStorage` compared with Python `contextvars` and Go `context.Context`, why global state breaks `test.concurrent`, and why the runtime lives on `globalThis` (Review Focus 1).
- [x] **Step 6: Commit** `feat: add replay session state machine`

---

### Task 7: HTTP capture, SSE and the dispatcher interceptor

**Files:**
- Create: `src/http/sse.ts`, `src/http/capture.ts`, `src/http/handler.ts`, `src/http/interceptor.ts`, `test/support/http-server.ts`, `docs/learning/undici-and-streams.md`
- Test: `test/unit/sse.test.ts`, `test/unit/capture.test.ts`, `test/integration/interceptor.test.ts`

**Interfaces:**
- Consumes: `runtime()`, `getConfig()`, `isProviderHost`, `resolveMode`, `Session.decideLlm`, normalize helpers, `ProviderCallBlockedError`.
- Produces:
  ```ts
  // sse.ts
  export function parseSse(text: string): SseEvent[];    // handles \r\n, multi-line data, ignores comments and id/retry
  export function serializeSse(events: SseEvent[]): string[]; // one "event: x\ndata: ...\n\n" chunk per event
  // capture.ts
  export function captureRequest(input: { method: string; origin: string; path: string; headers: Record<string, string>; body: Buffer | undefined }, config: AgentRetraceConfig): { request: RecordedRequest; secrets: string[] };
  export function captureResponse(status: number, headers: Record<string, string>, body: Buffer, secrets: string[], config: AgentRetraceConfig): RecordedResponse; // throws on unsupported content-encoding
  export function encodeResponse(r: RecordedResponse): { status: number; headers: Record<string, string>; chunks: Buffer[] };
  export function isTransientStatus(status: number): boolean;  // 408, 409, 429, >= 500
  export function errorResponse(message: string): RecordedResponse; // 400, {"type":"error","error":{"type":"agent_retrace_error","message":...}}
  // handler.ts
  export interface ResponseSink { start(abort: (reason?: Error) => void): void; headers(status: number, headers: Record<string, string>, statusText: string): boolean; data(chunk: Buffer): boolean; end(): void; error(err: Error): void }
  export function toSink(handler: object): ResponseSink;
  export interface TeeObserver { headers(status: number, headers: Record<string, string>): void; data(chunk: Buffer): void; end(): void; error(err: Error): void }
  export function teeHandler(handler: object, observer: TeeObserver): object;
  export function playResponse(sink: ResponseSink, encoded: ReturnType<typeof encodeResponse>): void;
  // interceptor.ts
  export function installInterceptor(): void;  // idempotent; re-wraps when the current global dispatcher is not ours
  export function installHttpGuard(): void;    // idempotent
  ```

Decisions:
- **Hook point:** the global dispatcher at `globalThis[Symbol.for("undici.globalDispatcher.1")]`. Node's built-in `fetch` reads it on every request. When it is unset (no fetch has run yet), create `new Agent()` from npm `undici`. Install a `Proxy` over the original whose `get` overrides only `dispatch` and forwards every other property (bound). Mark it with a private symbol so `installInterceptor` can tell whether the current dispatcher is ours. Verified on Node 22.22: the Proxy approach works and the handler uses the legacy API (`onConnect, onHeaders, onData, onComplete, onError, onUpgrade`).
- **Handler API:** Node 22 bundles undici 6 (legacy API). Node 24/26 bundle undici 7/8, which may pass the new API (`onRequestStart(controller)`, `onResponseStart(controller, status, headers, statusMessage)`, `onResponseData(controller, chunk)`, `onResponseEnd(controller, trailers)`, `onResponseError(controller, err)`). `toSink` and `teeHandler` support both. Legacy `onHeaders` receives `rawHeaders` as a flat `Buffer[]` (`[k, v, k, v]`). `teeHandler` implements both families and forwards each call to the inner handler's same-named method. The CI matrix (22/24/26) is the test for this.
- **dispatch flow:**
  1. Build a `URL` from `opts.origin` + `opts.path`. If it is not a provider host, return `original.dispatch(opts, handler)`.
  2. Otherwise return `true` synchronously and continue asynchronously. Collect `opts.body` (string, `Uint8Array`, or async iterable) into a `Buffer`. Look up `runtime().als.getStore()`.
  3. No session: if `resolveMode()` is `replay`, answer with `errorResponse` for `ProviderCallBlockedError(url, "outside-replay")`. Otherwise forward live, untouched and unrecorded.
  4. Session `closed`: answer with `errorResponse` for the `after-replay` reason.
  5. Session open: `captureRequest`, then `decideLlm`. On `replay`, `playResponse`. On `fail`, `playResponse(errorResponse(error.message without ANSI))`. On `live`, forward `original.dispatch({ ...opts, body: buffer }, teeHandler(handler, observer))`; when the response ends, `commit(isTransientStatus ? undefined : step)`, and on error, `commit(undefined)`.
- **Why a 400 instead of a network error:** both SDKs retry connection errors with backoff (slow tests) but do not retry 400. Both read `error.message` from this body shape, so the agent-retrace message surfaces even when `replay()` is bypassed.
- **captureRequest:** headers are lowercased. Only `MATCHED_REQUEST_HEADERS` are kept, and `secrets` come from `secretsFromHeaders` on all headers plus `process.env.OPENAI_API_KEY`/`ANTHROPIC_API_KEY` when set. A JSON body is parsed into `body`, otherwise stored as `text`. Then `redactDeep(config.redact)` and `scrubSecrets(secrets)`.
- **captureResponse:** decode `content-encoding` `gzip`, `deflate` and `br` with `node:zlib`. `text/event-stream` goes to `events` via `parseSse`. JSON goes to `body`. Anything else goes to `text`. Keep only `KEPT_RESPONSE_HEADERS`. Then redact and scrub.
- **playResponse:** call `start(abort)`, then on `setImmediate` call `headers`, then each chunk on its own `setImmediate` tick (SSE is one chunk per event, so the SDK sees a real stream), then `end`. If `abort` is called, stop and call `error(reason ?? new DOMException("aborted", "AbortError"))`. Never send `content-encoding` or `content-length`.
- **installHttpGuard:** wrap `request` and `get` of `node:http` and `node:https`, then call `syncBuiltinESMExports()` from `node:module` so named ESM imports see the wrapper. A provider host throws `ProviderCallBlockedError(url, "node-http")` when a session is active, or when there is no session and the mode is `replay`. Everything else passes through. The error message says agent-retrace intercepts provider calls made with `fetch` only.

- [x] **Step 1: Write failing unit tests** (`sse.test.ts`, `capture.test.ts`)

```ts
test("parse/serialize SSE round trip", () => {
  const raw = 'event: message_start\ndata: {"a":1}\n\ndata: [DONE]\n\n';
  expect(parseSse(raw)).toEqual([{ event: "message_start", data: { a: 1 } }, { text: "[DONE]" }]);
  expect(parseSse(serializeSse(parseSse(raw)).join(""))).toEqual(parseSse(raw));
});
test("CRLF and multi-line data", () => expect(parseSse("data: a\r\ndata: b\r\n\r\n")).toEqual([{ text: "a\nb" }]));
test("captureRequest strips auth and scrubs key echoes", () => {
  const { request } = captureRequest({ method: "POST", origin: "https://api.openai.com", path: "/v1/chat/completions",
    headers: { Authorization: "Bearer sk-test-SECRET123", "OpenAI-Beta": "x", "x-stainless-os": "Linux" },
    body: Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "my key is sk-test-SECRET123" }] })) }, getConfig());
  expect(request.headers).toEqual({ "openai-beta": "x" });
  expect(JSON.stringify(request)).not.toContain("sk-test-SECRET123");
});
test("gzip response decoded", () => {
  const r = captureResponse(200, { "content-type": "application/json", "content-encoding": "gzip", "set-cookie": "s=1" }, gzipSync('{"ok":true}'), [], getConfig());
  expect(r).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true } });
});
test.each([[429, true], [500, true], [503, true], [400, false], [200, false]])("transient %d", (s, t) => expect(isTransientStatus(s)).toBe(t));
```

- [x] **Step 2: Write failing integration tests** (`interceptor.test.ts`)

`test/support/http-server.ts` exports `startServer(handler): Promise<{ url: string; host: string; hits: number; close(): Promise<void> }>` on `127.0.0.1:0`. Configure that `host` as a provider host. Drive sessions directly with `runtime().als.run(new Session(...), fn)` using plain `fetch`.

```ts
test("non-provider traffic passes through in replay mode", async () => { /* stubEnv mode=replay; fetch another local server outside the provider list -> 200 */ });
test("provider call outside replay() is blocked in replay mode", async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  const res = await fetch(`${provider.url}/v1/chat/completions`, { method: "POST", body: "{}" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toMatch(/outside replay/);
  expect(provider.hits).toBe(0);
});
test("provider call outside replay() passes through in auto mode", async () => {});
test("record then replay via session, streamed SSE arrives in chunks", async () => { /* record mode session hits server once; strict session replays without hitting; reader gets >= 3 chunks */ });
test("gzip from server stored decoded", async () => { /* server gzips; saved step response.body is an object */ });
test("abort during replay rejects with AbortError", async () => {});
test("node:https to provider host throws in replay mode", () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  expect(() => https.request("https://api.openai.com/v1/models")).toThrow(ProviderCallBlockedError);
});
test("installInterceptor is idempotent", () => { installInterceptor(); installInterceptor(); /* wrapped exactly once: provider hits stay correct */ });
```

- [x] **Step 3:** Run `npx vitest run test/unit/sse.test.ts test/unit/capture.test.ts test/integration/interceptor.test.ts`. Expected: FAIL.
- [x] **Step 4:** Implement the four files.
- [x] **Step 5:** Re-run. Expected: PASS.
- [x] **Step 6: Learning note** `docs/learning/undici-and-streams.md`: Node's fetch is undici, what a dispatcher is, the handler callbacks, backpressure, `setImmediate` vs `process.nextTick`, why fetch decompresses but dispatcher bytes are raw, and patching built-ins with `syncBuiltinESMExports`.
- [x] **Step 7: Commit** `feat: intercept provider HTTP calls via the global undici dispatcher`

---

### Task 8: Public API: `replay()`, `recordTool()`, `configure()`

**Files:**
- Create: `src/replay.ts`
- Modify: `src/index.ts`
- Test: `test/integration/replay.test.ts`, `test/integration/tools.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (exported from `src/index.ts`):
  ```ts
  export interface ReplayOptions { dir?: string } // overrides <test dir>/__recordings__
  export function replay<T>(name: string, fn: () => T | Promise<T>, options?: ReplayOptions): Promise<Awaited<T>>;
  export function recordTool<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>): (...args: A) => Promise<Awaited<R>>;
  export { configure } from "./config.js";
  export type { Mode, ConfigureOptions, RedactRule } from "./config.js";
  export type { Recording, Step, LlmStep, ToolStep, RecordedRequest, RecordedResponse, SseEvent, ToolOutcome, JsonValue } from "./recording/format.js";
  export * from "./errors.js";
  ```
  `src/index.ts` calls `installInterceptor()` and `installHttpGuard()` at import.

`replay` flow:
1. Synchronously, before any `await`: `validateRecordingName`, `callerTestFile()`, and resolve `dir`. If there is no test file and no `options.dir`, throw `ReplayUsageError`.
2. If `runtime().als.getStore()` is set, throw `ReplayUsageError("replay() cannot be nested")`.
3. Path is `recordingPath(dir, name)`. If it is in `activePaths`, throw `ReplayUsageError` (two concurrent tests using one recording). Add it to `activePaths` and remove it in `finally`.
4. `installInterceptor()` again (Review Focus 2). Then `mode = resolveMode()`, `recording = await loadRecording(...)`.
5. In `replay` mode with no recording, throw `RecordingNotFoundError` with the message: `No recording "{name}" at {rel path}. Recordings are created when tests run locally (without CI set). Run {command without AGENT_RETRACE_MODE} and commit the __recordings__ folder.`
6. Strategy: replay+rec or auto+rec is `strict`, auto+none is `record`, update+rec is `update`, update+none is `record`.
7. Run `fn` via `als.run(session, fn)`, catch its error, call `session.finish(...)`, and return fn's value.

`recordTool`: with no session, call `fn` directly. With a session, `decideTool(name, toJsonArgs(args))`. On `replay`, return the stored value, or throw an `Error` with `name`/`message` restored. On `fail`, throw the error. On `live`, run `fn`, then `commit` a `return` outcome (JSON round-tripped through `toJsonArgs([value])[0]`) or a `throw` outcome, and rethrow. The wrapper is always async: the README must state this.

- [x] **Step 1: Write failing tests** (plain `fetch` against `startServer` as provider, `options.dir` set to a tmp dir)

```ts
test("auto records on first run, replays on second without network", async () => {
  await replay("r1", agentCallingServerTwice, { dir });
  expect(server.hits).toBe(2);
  await replay("r1", agentCallingServerTwice, { dir });
  expect(server.hits).toBe(2);
  expect(existsSync(join(dir, "r1.json"))).toBe(true);
});
test("replay mode without recording fails before any network", async () => {
  vi.stubEnv("AGENT_RETRACE_MODE", "replay");
  await expect(replay("missing", agentCallingServerTwice, { dir })).rejects.toThrow(RecordingNotFoundError);
  expect(server.hits).toBe(0);
});
test("auto mode never re-records on change", async () => { /* record, change body, expect ChangeDetectedError and file bytes unchanged */ });
test("swallowed SDK error still fails the test", async () => {
  await replay("r2", callOnce("a"), { dir });
  await expect(replay("r2", async () => { try { await callOnce("b")(); } catch {} return "fallback"; }, { dir }))
    .rejects.toBeInstanceOf(ChangeDetectedError);
});
test("update mode rewrites only from the change and counts live calls", async () => {
  await replay("r3", calls(["a", "b", "c"]), { dir }); const before = server.hits;
  vi.stubEnv("AGENT_RETRACE_MODE", "update");
  await replay("r3", calls(["a", "B", "c"]), { dir });
  expect(server.hits - before).toBe(2);   // steps 2 and 3 live; step 1 replayed
});
test("concurrent replays do not mix", async () => {
  await Promise.all([replay("c1", calls(["x"]), { dir }), replay("c2", calls(["y"]), { dir })]);
  expect(stepsOf("c1")).toHaveLength(1); expect(stepsOf("c2")).toHaveLength(1);
});
test("nested replay throws", async () => {});
test("same recording concurrently throws", async () => {});
test("default dir is __recordings__ next to the test file", async () => { /* no dir option; file appears at join(dirname(thisFile), "__recordings__", name + ".json"); clean up */ });
test("re-installs when another library replaced the global dispatcher", async () => {
  await replay("r4", calls(["a"]), { dir });
  const sym = Symbol.for("undici.globalDispatcher.1"); (globalThis as any)[sym] = new Agent();
  vi.stubEnv("AGENT_RETRACE_MODE", "replay"); const before = server.hits;
  await replay("r4", calls(["a"]), { dir });
  expect(server.hits).toBe(before);
});
test("redaction rule applies to recording and to matching", async () => {
  configure({ providerHosts: [server.host], redact: [/ORDER-\d+/] });
  await replay("r5", calls(["refund ORDER-123"]), { dir });
  expect(readFileSync(join(dir, "r5.json"), "utf8")).not.toContain("ORDER-123");
  await replay("r5", calls(["refund ORDER-999"]), { dir });  // still matches after redaction
});
// tools.test.ts
test("wrapped tool recorded, then replayed without running", async () => { /* impl spy called once across record+replay */ });
test("wrapped tool error replays as thrown Error with same name and message", async () => {});
test("tool args change reports `tool \\`search\\``", async () => { /* message contains "tool `search`" and the args diff */ });
test("unwrapped use outside replay() calls through", async () => {});
test("Vercel-style second arg with AbortSignal is accepted", async () => {});
```

Also add `test/integration/duplicate-module.test.ts`: import `../../src/index.js?copy=2` as `copyB`, run `copyB.replay(...)` doing a provider `fetch`. Expect it to be recorded, which proves the interceptor installed by copy A found copy B's session (Review Focus 1).

- [x] **Step 2:** Run `npx vitest run test/integration`. Expected: the new tests FAIL.
- [x] **Step 3:** Implement `src/replay.ts` and update `src/index.ts`.
- [x] **Step 4:** Run `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [x] **Step 5: Commit** `feat: add replay() and recordTool() public API`

---

### Task 9: Fake provider and SDK compatibility suite

**Files:**
- Create: `test/support/fake-provider.ts`, `test/sdk/openai.test.ts`, `test/sdk/anthropic.test.ts`, `test/sdk/vercel-ai.test.ts`, `test/sdk/secrets.test.ts`

**Interfaces:**
- Consumes: public API, `startServer`.
- Produces:
  ```ts
  export interface FakeReply { text?: string; toolCall?: { id: string; name: string; args: Record<string, JsonValue> } }
  export interface FakeProvider {
    baseURL: string; host: string;   // host is "127.0.0.1:<port>"
    calls: Array<{ path: string; body: JsonValue; headers: Record<string, string> }>;
    reply(fn: (call: { path: string; body: JsonValue }) => FakeReply): void;
    close(): Promise<void>;
  }
  export function startFakeProvider(opts?: { gzip?: boolean; failFirst?: number; setCookie?: boolean }): Promise<FakeProvider>;
  ```

The fake serves, with and without `stream: true`:
- `POST /v1/chat/completions`: a `chat.completion` object, or `chat.completion.chunk` SSE ending in `data: [DONE]`.
- `POST /v1/responses`: a `response` object with `output` items `message`/`output_text` or `function_call`. Streaming emits `response.created`, `response.output_item.added`, `response.output_text.delta` or `response.function_call_arguments.delta`, `response.output_item.done`, `response.completed`, with `event:` lines.
- `POST /v1/messages`: an Anthropic `message`. Streaming emits `message_start`, `content_block_start`, `content_block_delta` (`text_delta` / `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`.

Every response sets `x-request-id`, plus `set-cookie` when `setCookie` is on. `failFirst: n` answers the first n calls with 429. The SDKs validate shapes (the Vercel AI SDK strictly). Iterate on the fake until each SDK parses it, and do not loosen assertions.

Each SDK test uses `baseURL: fake.baseURL + "/v1"` (Anthropic: `fake.baseURL`), `apiKey: "sk-test-SECRET123456"`, `maxRetries: 2`, and `configure({ providerHosts: [fake.host] })`. Pattern for every case:

```ts
test.each([false, true])("openai chat completions (stream=%s) record -> replay", async (stream) => {
  const first = await replay(`oa-chat-${stream}`, () => runChat(client, stream), { dir });
  expect(fake.calls).toHaveLength(2);                      // tool call + final answer
  vi.stubEnv("AGENT_RETRACE_MODE", "replay"); await fake.close();
  const second = await replay(`oa-chat-${stream}`, () => runChat(client, stream), { dir });
  expect(second).toEqual(first);
});
test("system prompt change -> step 1 of 2 with system diff", async () => {
  await expect(replay("oa-chat-false", () => runChat(client, false, "New system prompt"), { dir }))
    .rejects.toThrow(/changed at step 1 of 2[\s\S]*System prompt:[\s\S]*\+ New system prompt/);
});
```

Cases:
- **openai:** chat completions stream/non-stream; responses stream/non-stream; a client constructed before `replay()` (at module top level) is still intercepted.
- **anthropic:** messages stream/non-stream; a tool-use round trip.
- **vercel-ai:** `generateText` and `streamText` with `@ai-sdk/openai` (`createOpenAI({ baseURL })`) and `@ai-sdk/anthropic` (`createAnthropic({ baseURL })`), including a tool whose `execute` is wrapped with `recordTool`.
- **transient (Review Focus 4):** `failFirst: 1` while recording. The recording has exactly 2 LLM steps and none has status 429. Replay completes in under 500 ms.
- **gzip (Review Focus 3):** `gzip: true`. The recording file contains readable JSON, and replay works.

`secrets.test.ts`, run after recording with every SDK above (`setCookie: true`, prompt text containing the API key): the concatenated text of every file in `dir` matches none of `/sk-test-SECRET123456/`, `/authorization/i`, `/x-api-key/i`, `/set-cookie/i`.

- [ ] **Step 1:** Write `fake-provider.ts` and the SDK tests.
- [ ] **Step 2:** Run `npx vitest run test/sdk`. Expected: the first run surfaces real gaps (fake shape or interceptor). Fix the fake for shape errors. Fix `src/` for interceptor or format bugs, adding a unit test in the owning task's test file for each `src/` fix.
- [ ] **Step 3:** Run `npm test`. Expected: all PASS.
- [ ] **Step 4:** Read one recording of each API shape and check that it is readable in code review (SSE stored as events, not escaped strings). Fix the format if it is not.
- [ ] **Step 5: Commit** `test: add SDK compatibility suite for OpenAI, Anthropic and Vercel AI SDK`

---

### Task 10: `node:test` support

**Files:**
- Create: `test/node-test/replay.test.mjs`, `test/node-test/__recordings__/node-test-basic.json` (generated)

**Interfaces:**
- Consumes: the built package via self-reference, `import { replay, configure, recordTool } from "agent-retrace"`, which resolves through `exports` to `dist`.

- [ ] **Step 1: Write the test** (plain JS, `node:test` + `node:assert/strict`, a local `http.createServer` provider configured as a provider host)

Tests:
- Records in auto mode, then replays with `AGENT_RETRACE_MODE=replay`, with server hits unchanged.
- The default `__recordings__` dir is next to this `.mjs` file (proves `callerTestFile` works with `file://` frames).
- A changed request rejects with a message containing `AGENT_RETRACE_MODE=update node --test test/node-test/replay.test.mjs`.

- [ ] **Step 2:** Run `npm run test:node`. Expected: FAIL first only if something in `src/` is wrong. Fix it there with a unit test. Expected final: PASS.
- [ ] **Step 3: Commit** `test: cover node:test runner against the built package`

---

### Task 11: CLI `agent-retrace inspect <file>`

**Files:**
- Create: `src/cli.ts`, `docs/learning/cli.md`
- Modify: `package.json` (add `"bin": {"agent-retrace": "./dist/cli.js"}`, deferred from Task 1 so publint passes before `dist/cli.js` exists)
- Test: `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: `parseRecording`, `toSemantic`, `describeStep`.
- Produces: `export function formatTimeline(r: Recording, opts?: { color?: boolean }): string` and `export async function main(argv: string[]): Promise<number>` (the exit code). The file starts with `#!/usr/bin/env node` and calls `main(process.argv.slice(2))` only when run directly (compare `import.meta.url` with `pathToFileURL(process.argv[1])` after `realpath`, because npm's `bin` is a symlink).

Output (exact shape):
```
refund-damaged-order  (9 steps, format v1)

 1  LLM   POST api.openai.com/v1/chat/completions  model=gpt-x  stream
        > user: My order arrived broken
        < assistant -> tool_call lookup_order({"orderId":"A1"})
 2  tool  lookup_order({"orderId":"A1"})
        < {"status":"delivered","damaged":true}
```
- Request summary: the last message line from `toSemantic`, truncated to 100 characters with `...`.
- Response summary: assistant text or tool calls, reconstructed from `body` or by concatenating streamed deltas from `events` (OpenAI chat, Responses, Anthropic). Otherwise `HTTP <status>`.
- Tool outcome: the `stableStringify`'d value on one line, truncated, or `throws Name: message`.
- Exit codes: 0 ok; 1 for an unreadable or invalid file (print the `RecordingFormatError` message); 2 for usage (`Usage: agent-retrace inspect <file>`, also for `--help` with exit 0). Parse arguments with `node:util` `parseArgs`.

- [ ] **Step 1: Write failing tests** using a fixture recording from Task 9 copied into `test/integration/fixtures/`: `formatTimeline` output contains `" 1  LLM   POST"` and `"< assistant"`; `main(["inspect", fixture])` returns 0; a missing file returns 1; `main([])` returns 2; running `node dist/cli.js inspect <fixture>` via `execFile` after build exits 0.
- [ ] **Step 2:** Run `npx vitest run test/integration/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, plus `npm run build && node dist/cli.js inspect test/integration/fixtures/<file>`. Expected: PASS, and the output looks right in a real terminal.
- [ ] **Step 5: Learning note** `docs/learning/cli.md`: `process.argv`, `parseArgs`, exit codes, shebang and npm `bin` symlinks, the "is main module" check compared with Python's `if __name__ == "__main__"`.
- [ ] **Step 6: Commit** `feat: add agent-retrace inspect CLI`

---

### Task 12: Example support agent and offline CI job

**Files:**
- Create: `examples/support-agent/agent.ts`, `examples/support-agent/tools.ts`, `examples/support-agent/agent.test.ts`, `examples/support-agent/__recordings__/*.json`, `examples/support-agent/README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `runSupportAgent(message: string, opts?: { systemPrompt?: string; client?: OpenAI }): Promise<{ action: "refund" | "replace" | "escalate" | "answer"; reply: string }>`, which uses the official `openai` SDK Chat Completions with function tools, loops until there is no tool call (max 6 turns), and has `DEFAULT_SYSTEM_PROMPT` exported.
- `tools.ts`: `lookupOrder`, `issueRefund` and `searchPolicies`, each exported already wrapped: `export const lookupOrder = recordTool("lookup_order", lookupOrderImpl)`. The impls read an in-memory fake order DB.

Tests in `agent.test.ts` (import from `"agent-retrace"`, the published entry):
1. `refund-damaged-order`: `"My order A1 arrived broken"` gives `action === "refund"`.
2. `where-is-my-order`: gives `action === "answer"`.
3. `system prompt change is reported`: in replay mode, `runSupportAgent("My order A1 arrived broken", { systemPrompt: DEFAULT_SYSTEM_PROMPT + "\nAlways offer a discount code." })` inside `replay("refund-damaged-order", ...)` rejects, and the message matches `/changed at step 1 of \d+/` and `/\+ Always offer a discount code\./`. Wrap it in `vi.stubEnv("AGENT_RETRACE_MODE", "replay")` so it can never re-record.

- [ ] **Step 1:** Write the agent, tools and tests.
- [ ] **Step 2: Record against the real API.** This needs `OPENAI_API_KEY`. If it is not set in the environment, stop and ask the owner to run `! OPENAI_API_KEY=... npm run test:example` locally. Use a current small, cheap OpenAI chat model. Expected: tests 1 and 2 pass and create `__recordings__/refund-damaged-order.json` and `where-is-my-order.json`. Test 3 passes against them.
- [ ] **Step 3: Inspect the recordings** with `node dist/cli.js inspect examples/support-agent/__recordings__/refund-damaged-order.json`. Grep both files for `sk-`, `authorization` and `cookie`. Expected: none.
- [ ] **Step 4: Prove offline replay locally:** `env -u OPENAI_API_KEY CI=true npm run test:example`. Expected: PASS.
- [ ] **Step 5: Add CI job `example-offline`** (Node 22, after `npm ci && npm run build`): `docker run --rm --network none -e CI=true -v "$PWD":/w -w /w node:22 npx vitest run --project example`. No secrets in the job. This is the spec's "no API keys and no network access" proof.
- [ ] **Step 6:** Run `npm run ci`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: add example support agent with committed recordings`

---

### Task 13: README, demo GIF and publish readiness

**Files:**
- Create: `README.md`, `docs/demo/demo.tape`, `docs/demo/demo.gif`
- Modify: `package.json` (`description`, `homepage`, `bugs`)

- [ ] **Step 1: Research the comparison.** For each of tomiko, llm-cassette, cassette, retake, agent-replay and agentverify, find the repo/npm/PyPI page and record language, interception level, streaming support, mismatch behavior, partial re-record, and last release date. Every claim in the table links its source. Mark anything unverifiable as "unknown". The comparison must be honest, including where those tools are ahead.
- [ ] **Step 2: Write `README.md`.** Sections in order:
  1. One-line pitch.
  2. The demo GIF.
  3. Quick start: `npm i -D agent-retrace`, a Vitest example copied from the spec section 6.1, run it, commit `__recordings__`.
  4. What a change looks like (paste real `renderChange` output from the example test).
  5. Modes table (copied from spec 6.6).
  6. `recordTool` (the wrapper is always async).
  7. `configure()`: provider hosts, with a prominent note that a custom `baseURL` must be added or its calls are neither recorded nor blocked. Also redaction (applies to matching too) and ignore paths.
  8. Optional setup file (`setupFiles: ["agent-retrace"]`) to block provider calls in tests that do not use `replay()`.
  9. `node:test` usage.
  10. CLI.
  11. Recording format.
  12. Limitations: fetch-based clients only (`node:http` provider calls throw), clients given their own undici dispatcher bypass interception, no clock/random freezing.
  13. Comparison table.
  14. License.

  No em dashes.
- [ ] **Step 3: Record the demo GIF** with VHS (`go install github.com/charmbracelet/vhs@latest`; it needs `ttyd` and `ffmpeg`). Tape, about 20 s: run the example test (passes from recordings), edit the system prompt with `sed`, run again (show the "changed at step 1 of N" diff), run `AGENT_RETRACE_MODE=update` (needs the owner's key; otherwise end the tape at the diff and note it). Output `docs/demo/demo.gif`, at most 2 MB.
- [ ] **Step 4: Publish readiness:** `npm run ci` passes; `npm pack --dry-run` lists only `dist/**`, `README.md`, `LICENSE` and `package.json`; `npm run check:package` passes; install the packed tarball into a scratch project and run a one-test Vitest file against it. Expected: all pass. Do not run `npm publish`; the owner publishes.
- [ ] **Step 5: Commit** `docs: add README, demo GIF and comparison`

---

## Spec coverage map

| Spec item | Task |
|---|---|
| 3.1 record LLM and wrapped tools as one ordered recording | 6, 7, 8 |
| 3.2 / 3.5 / 5 offline replay, never call a provider in CI | 7, 8, 12 |
| 3.3 / 6.5 first changed step, position, readable diff, command, more/fewer calls | 5, 6, 8 |
| 3.4 / 6.6 update mode, verified by call count | 6, 8, 9 |
| 6.1 `replay(name, fn)`, Vitest and `node:test`, ALS isolation | 6, 8, 10 |
| 6.2 HTTP-level interception, provider hosts, SSE, `recordTool` | 2, 7, 8, 9 |
| 6.3 JSON file, `__recordings__`, stable order, version, redaction | 3, 4, 7 |
| 6.4 matching, ignore rules, concurrency | 4, 6 |
| 6.7 `inspect` CLI | 11 |
| 7 constraints (Node >=22, ESM, types, MIT, JSDoc, no em dash) | 1, all |
| 9 Biome + pre-commit, learning notes, example agent | 1, each task, 12 |
| 12 success criteria | 9 (SDKs, secrets, call count), 12 (offline CI, prompt edit), 13 (README, GIF, npm-ready) |
