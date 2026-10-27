# Process-wide state, errors and environment

Node concepts used by `src/errors.ts`, `src/runtime.ts` and `src/config.ts`.

## One module, many copies

Python caches each module once in `sys.modules`; Go links each package once. Node usually does
too, but not always:

- Vitest gives each test file a fresh module graph, so `src/runtime.ts` is evaluated again per file.
- npm can install a package twice (two versions, or a nested `node_modules`), and each copy has its
  own module scope.
- The same file imported with a different query string (`runtime.js?copy=2`) is a separate module.

A `let sessions = ...` at module scope would therefore exist once per copy. An interceptor installed
by one copy would not see sessions started by another.

## `globalThis` and `Symbol.for`

`globalThis` is the one global object per process (per realm), like Python's `builtins`. State
stored on it is shared by every module copy. To avoid clashing with other libraries the key is a
symbol, not a string. `Symbol("x")` creates a new, unique symbol on every call, so two copies would
still disagree. `Symbol.for("x")` looks the symbol up in a process-wide registry, so every copy gets
the same one. The key carries a version (`agent-retrace.runtime.v1`) so a future incompatible shape
can live next to it.

`??=` assigns only when the left side is `null` or `undefined`, so the first copy creates the
object and later copies reuse it.

## `AsyncLocalStorage`

`AsyncLocalStorage` (from `node:async_hooks`) carries a value through `await`, timers and callbacks
started inside `als.run(value, fn)`. It plays the role of Python's `contextvars` or a Go
`context.Context` you never have to pass by hand. One instance lives on the runtime object so every
copy reads the same store.

## Avoiding circular imports

`config.ts` needs `runtime()`, and `runtime.ts` needs a default config to create the runtime. If
each imported the other, ESM would allow it, but only as long as neither calls into the other while
the modules are first evaluated: a top-level call across the cycle hits a not-yet-initialized
binding and throws (Python would instead see a half-filled module). That holds today and breaks
silently later. So the defaults live in `defaults.ts`, which imports nothing at runtime, and
`runtime.ts` imports `config.ts` only with `import type`, which TypeScript erases from the output.

## URL host and port quirks

`new URL()` lowercases hostnames, converts IDN names to punycode, and drops the scheme's default
port: `new URL("https://h:443/").port` is `""`. So a configured `"h:443"` is compared against the
request's port with the default restored. Configured entries are parsed with a made-up scheme
(`x://h:443`), because non-special schemes keep every port as written. A hostname may end in a
dot (`api.openai.com.`), which DNS treats as the same host, so the dot is dropped on both sides.

## Error subclasses

`class X extends Error` works, but `name` stays `"Error"` unless set. The base class sets
`this.name = new.target.name`, where `new.target` is the class actually being constructed. The
`cause` option (`new Error(msg, { cause })`) chains errors like Python's `raise ... from err`.

## Environment variables

`process.env` values are always strings or `undefined`. `CI=false` is a set variable whose value is
the string `"false"`, so the mode logic treats empty, `"0"` and `"false"` as unset explicitly.

## `@types/node`

TypeScript 7 does not load every `@types/*` package automatically. `tsconfig.json` lists
`"types": ["node"]` so `process`, `NodeJS.ProcessEnv` and `node:*` modules type-check in builds
that include only `src`.
