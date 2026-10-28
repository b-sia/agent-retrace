# Diffs, terminal color and process arguments

Node concepts used by `src/diff/semantic.ts`, `src/diff/render.ts` and `src/diff/command.ts`.

## The `diff` package

`diff` (jsdiff) is the npm equivalent of Python's `difflib` or Go's `go-diff`. Every function
returns a list of change objects `{ value, added, removed, count }`, in order: unchanged runs
have both flags false.

- `diffArrays(a, b)` compares element by element with `===`. The renderer uses it for both
  message lines and text lines (after `split("\n")`).
- `diffLines(a, b)` does the splitting itself, but keeps each line's `\n` inside `value`. Then
  `"a"` against `"a\n"` reports one removed line and one added line that print the same.
  Splitting first turns the trailing newline into an added empty line, which is visible.

## Terminal color

`picocolors` wraps text in ANSI escape codes (`\x1b[31m` ... `\x1b[39m` for red), like Python's
`colorama` or Go's `fatih/color`. `pc.isColorSupported` is decided once at import from
`NO_COLOR`, `FORCE_COLOR`, `--no-color`/`--color`, whether stdout is a TTY, and `CI`.
`pc.createColors(enabled)` returns the same functions bound to an explicit choice, which keeps
rendering testable: tests pass `color: false` and compare plain strings.

## `process.argv` and `process.execArgv`

Python's `sys.argv` starts at the script. Node's `process.argv` starts at the Node binary:
`[execPath, script, ...args]`. Flags for Node itself (`--test`, `--import`) are moved out into
`process.execArgv`, so `node --test a.mjs` has `--test` in `execArgv`, not in `argv`.

`node --test` runs each test file in its own child process, and the child gets neither flag.
Node marks it with the environment variable `NODE_TEST_CONTEXT` (for example `child-v8`)
instead. With `--test-isolation=none` the files run in the parent and none of these signals
are present, so the runner is reported as unknown and the re-record hint stays generic.

Vitest sets `VITEST` in every worker, which is the usual way to detect it.

## Paths in shell commands

`path.relative(from, to)` gives a path with the platform's separator (`\` on Windows), so the
command joins segments with `/` for display. A path with spaces or quotes is wrapped in single
quotes, with `'` written as `'\''`, the POSIX way to embed a quote in a single-quoted word.
