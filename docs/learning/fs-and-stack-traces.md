# Files, atomic writes and stack traces

Node concepts used by `src/recording/format.ts` and `src/recording/store.ts`.

## `fs/promises`

`node:fs` has three flavors of every call: callback (`fs.readFile(p, cb)`), synchronous
(`fs.readFileSync`) and promise-based (`node:fs/promises`). The promise flavor is the one to use
with `async`/`await`, like Python's `aiofiles`, except it is built in. Sync calls block the whole
event loop (every concurrent test in the process), so library code avoids them.

Errors are plain `Error` objects with a string `code` (`"ENOENT"`, `"EACCES"`), the way Python
exposes `errno`. There is no `FileNotFoundError` class to catch, so the code checks
`err.code === "ENOENT"`.

`mkdir(dir, { recursive: true })` is `mkdir -p`: it creates parents and does not fail if the
directory already exists.

## Atomic writes with rename

`writeFile` truncates the target and then writes it, so a crash or Ctrl-C in between leaves a
half-written recording. Instead the contents go to a temporary file in the same directory, which is
then `rename`d over the target. On POSIX, `rename` within one filesystem is atomic: readers see the
old file or the new one, never a mix. The temp file must be in the same directory (not `os.tmpdir()`),
because a rename across filesystems fails with `EXDEV`. The temp name carries the process id and
random bytes so two processes saving at once never share a temp file.

## `import.meta.url` instead of `__dirname`

CommonJS modules get `__dirname` and `__filename` injected. ES modules do not; they get
`import.meta.url`, the module's own URL (`file:///home/.../store.js`). `new URL("../", import.meta.url)`
resolves relative to it, and `fileURLToPath` turns a `file://` URL into a platform path (it also
decodes `%20` and handles Windows drive letters, which string slicing would get wrong). Node 20.11+
also has `import.meta.dirname`, but the URL form works in every supported version and in Vitest.

## The V8 CallSite API

Python has `inspect.stack()`; Go has `runtime.Caller`. JavaScript has no standard equivalent, but V8
(the engine in Node) offers one: if `Error.prepareStackTrace` is set to a function, reading
`err.stack` calls it with the error and an array of `CallSite` objects instead of formatting a
string. Each `CallSite` has `getFileName()`, `getLineNumber()` and so on.

`Error.captureStackTrace(obj, fn)` fills `obj.stack` without creating an `Error`, leaving out `fn`
and every frame above it. `Error.stackTraceLimit` (default 10) caps how many frames are collected,
so the code raises it while capturing.

Both are process-wide globals, and other tools (source-map-support, test runners) set them too.
The code saves and restores them in `finally`, so an exception can never leave them changed.

File names in frames come in several shapes: `file://` URLs for ES modules, plain paths for
CommonJS, `node:internal/...` for Node's own code, `null` for native frames, and pseudo names such
as `[eval]` for `node -e`. A cache-busting import (`x.js?v=2`) keeps its query string.

`node:util` gained `getCallSites()` in 22.9, which does the same without touching globals, but
`engines.node` is `>=22`, so it cannot be relied on yet.

## Key order in `JSON.stringify`

JavaScript objects keep insertion order for string keys, but integer-like keys (`"2"`, `"10"`)
always come first, in numeric order, no matter when they were added. Reordering an object's keys
and calling `JSON.stringify` therefore cannot produce a fixed order, so `stableStringify` writes the
JSON itself. Keys are compared by UTF-16 code unit rather than `localeCompare`, whose result depends
on the machine's locale.
