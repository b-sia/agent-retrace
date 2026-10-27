# ESM and packaging

## ESM vs CommonJS

Node has two module systems. CommonJS (CJS) uses `require()` and `module.exports`, loaded
synchronously. ES modules (ESM) use `import`/`export`, are statically analyzable, and can use
top-level `await`. New libraries should ship ESM; modern Node (22+) can also `require()` ESM in
most cases, so ESM-only no longer cuts off CJS consumers.

## `"type": "module"`

This field in `package.json` tells Node that `.js` files in the package are ESM. Without it,
`.js` means CJS. (`.mjs` and `.cjs` always force one or the other.)

## The `exports` map

`exports` is the package's public surface. Only the listed subpaths can be imported; deep imports
like `agent-retrace/dist/internal.js` fail. Conditions pick the file per consumer: `types` for
TypeScript, `import` for ESM. Put `types` first, since conditions are matched in order.
`publint` and `attw` (are the types wrong) check that this map is consistent with the files.

## Why TS imports end in `.js`

With `moduleResolution: nodenext`, TypeScript does not rewrite import specifiers. Node needs a
real file extension at runtime, and the emitted file is `foo.js`, so the source must say
`import "./foo.js"` even though the file on disk is `foo.ts`. TypeScript maps it back when
type-checking.

## `bin` and shebangs

`bin` maps a command name to a script that npm links into `PATH` on install. The script must
start with `#!/usr/bin/env node` so the OS runs it with Node. The file needs no exec bit in the
repo; npm sets it on install.

## `engines`

`"engines": {"node": ">=22"}` declares supported Node versions. npm only warns by default
(set `engine-strict` to enforce). It is documentation plus a guard for CI matrices.

## Comparisons

- Python: `pyproject.toml` plays the role of `package.json`; `[project.scripts]` is `bin`;
  `requires-python` is `engines`. Python has no `exports` equivalent - everything importable is
  public by convention (underscore prefix), whereas `exports` enforces it.
- Go: modules are declared by `go.mod`; a package's public API is whatever is capitalized, and
  `internal/` directories are enforced private. `exports` is closer to that enforcement.
  Go has one module system, so there is no CJS/ESM split to manage.
