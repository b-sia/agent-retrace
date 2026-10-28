/**
 * The re-record command shown at the end of a change report: which test
 * runner is running, and how to run one test file again in update mode.
 */
import { relative, sep } from "node:path";

/** Test runners the command knows how to invoke. */
export type Runner = "vitest" | "node-test" | "unknown";

const UPDATE = "AGENT_RETRACE_MODE=update";

/**
 * Works out which test runner this process belongs to.
 *
 * `node --test` runs each test file in a child process. The child does not
 * get `--test` in its arguments; Node marks it with `NODE_TEST_CONTEXT`.
 * Node normally moves its own flags out of `process.argv` into
 * `process.execArgv`; `argv` is still searched, but only before the script
 * name, since flags after it belong to the script.
 *
 * @param env - Environment variables.
 * @param execArgv - Node's own flags (`process.execArgv`).
 * @param argv - The full command line (`process.argv`).
 * @returns The runner.
 */
export function detectRunner(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: string[] = process.execArgv,
  argv: string[] = process.argv,
): Runner {
  if (env.VITEST !== undefined) return "vitest";
  if (env.NODE_TEST_CONTEXT !== undefined) return "node-test";
  const script = argv.findIndex((arg, i) => i > 0 && !arg.startsWith("-"));
  const argvFlags = argv.slice(1, script === -1 ? undefined : script);
  return [...execArgv, ...argvFlags].includes("--test") ? "node-test" : "unknown";
}

/**
 * Quotes a word for a POSIX shell when it contains anything but safe
 * characters.
 *
 * @param word - The word.
 * @returns The word, quoted if needed.
 */
function shellQuote(word: string): string {
  return /^[\w./@%+=:,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the command that re-runs one test file in update mode.
 *
 * @param runner - The test runner.
 * @param testFile - Absolute path of the test file, when known.
 * @param cwd - Directory the command is run from.
 * @returns The command.
 */
export function rerecordCommand(runner: Runner, testFile: string | undefined, cwd: string): string {
  if (runner === "unknown" || testFile === undefined) return `${UPDATE} <your test command>`;
  const file = shellQuote(relative(cwd, testFile).split(sep).join("/"));
  return runner === "vitest" ? `${UPDATE} npx vitest run ${file}` : `${UPDATE} node --test ${file}`;
}
