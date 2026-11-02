# Command line programs in Node

Node concepts used by `src/cli.ts`.

## `process.argv`

`process.argv` is the full command line: `argv[0]` is the path of the `node` binary, `argv[1]` the
script, and the user's arguments start at `argv[2]`. Python's `sys.argv` starts with the script, so
the equivalent of `sys.argv[1:]` is `process.argv.slice(2)`. Go's `os.Args[1:]` is the same idea.
`main()` takes the sliced array as a parameter instead of reading `process.argv` itself, so tests can
call it with any arguments.

## `parseArgs` from `node:util`

`parseArgs` is Node's built-in argument parser, a small `argparse`/`flag`. It knows only the
options it is given:

```ts
parseArgs({ args, options: { help: { type: "boolean", short: "h" } }, allowPositionals: true });
```

It returns `{ values, positionals }`. In the default strict mode an unknown option (`--nope`)
throws a `TypeError` with a readable message instead of being ignored, and without
`allowPositionals` any bare word would throw too. Subcommands (`inspect`) are just the first
positional. It does no help text or validation of positionals; the CLI checks those itself.

## Exit codes

The CLI uses the usual Unix meanings: 0 success, 1 the operation failed (unreadable or invalid
file), 2 the command was used wrong (the same code `argparse` and most shells use for usage errors).

`process.exit(code)` ends the process immediately, like Python's `os._exit`, not `sys.exit`:
output still buffered for a pipe can be lost, because writes to pipes are asynchronous in Node.
Setting `process.exitCode = code` instead lets the event loop drain, then exits with that code.

## Shebang and npm `bin` symlinks

`#!/usr/bin/env node` on line 1 lets the OS run the file as a program. `tsc` keeps a shebang on the
first line of the output, so `src/cli.ts` carries it and `dist/cli.js` gets it.

`"bin": { "agent-retrace": "./dist/cli.js" }` in `package.json` makes npm create
`node_modules/.bin/agent-retrace` on install: a symlink to `dist/cli.js` on Linux and macOS (a
small `.cmd` wrapper on Windows), with the executable bit set. `npx agent-retrace` and npm scripts
put `node_modules/.bin` on `PATH`.

## "Is this the main module?"

Python has `if __name__ == "__main__":`. ES modules have no such flag (CommonJS had
`require.main === module`). The check here compares two URLs:

- `import.meta.url` is this module's own `file://` URL. Node resolves symlinks when it loads the
  entry script, so this is the real path, `.../dist/cli.js`.
- `process.argv[1]` is the path as typed, which for an installed CLI is the symlink
  `.../node_modules/.bin/agent-retrace`.

So `argv[1]` goes through `realpathSync` first, then `pathToFileURL` (which also percent-encodes
spaces and other characters the same way `import.meta.url` does). Without `realpath` the CLI works
with `node dist/cli.js` and silently does nothing when installed. Importing the module from code
(or from a test) leaves `argv[1]` pointing at some other script, so `main()` does not run.

Node 24.2 added `import.meta.main` for this, but `engines` allows Node 22, which does not have it.

## Colors and pipes

`process.stdout.isTTY` is `true` only when stdout is a terminal; it is `undefined` when output is
piped or redirected. The CLI colors only on a terminal, so `agent-retrace inspect x.json > out.txt`
writes plain text. `picocolors.isColorSupported` adds the `NO_COLOR` and `FORCE_COLOR` conventions.

When a reader closes the pipe early (`agent-retrace inspect x.json | head`), the next write fails
with `EPIPE`, which Node emits as an `error` event on `process.stdout`. With no listener that event
would crash the process with a stack trace, so the CLI listens and ignores `EPIPE`. Python gets a
`BrokenPipeError` in the same situation.
