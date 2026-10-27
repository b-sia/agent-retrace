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

## Circular imports

`config.ts` imports `runtime()` and `runtime.ts` imports `defaultConfig()`. ESM allows the cycle
because both only call the other module's function later, inside function bodies, never while the
modules are first evaluated. A top-level call across the cycle would hit a not-yet-initialized
binding and throw, unlike Python where it would see a half-filled module.

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
