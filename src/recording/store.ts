/**
 * Where recordings live on disk and how they are read and written.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidRecordingNameError, RecordingFormatError } from "../errors.js";
import { parseRecording, type Recording, serializeRecording } from "./format.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const MAX_NAME_LENGTH = 120;

// Windows refuses these as file names, with or without an extension, so a
// recording named "con" could be written on Linux but never checked out there.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Checks that a recording name can be used as a file name on every platform
 * as-is. Names are not slugged, so two different names never map to the same
 * file.
 *
 * @param name - The name passed to `replay()`.
 * @throws {InvalidRecordingNameError} When the name is empty, too long, starts
 *   with something other than a letter or digit, contains characters outside
 *   letters, digits, space, ".", "_" and "-", ends with "." or a space, or is a
 *   reserved Windows device name.
 */
export function validateRecordingName(name: string): void {
  const stem = name.split(".")[0] ?? "";
  if (
    name.length > MAX_NAME_LENGTH ||
    !NAME_PATTERN.test(name) ||
    name.endsWith(".") ||
    name.endsWith(" ") ||
    WINDOWS_RESERVED.test(stem.trimEnd())
  ) {
    throw new InvalidRecordingNameError(name);
  }
}

/**
 * Returns the recordings directory for a test file.
 *
 * @param testFile - Absolute path of the test file.
 * @returns `<dirname>/__recordings__`.
 */
export function recordingsDirFor(testFile: string): string {
  return join(dirname(testFile), "__recordings__");
}

/**
 * Returns the file path of a recording.
 *
 * @param dir - The recordings directory.
 * @param name - A validated recording name.
 * @returns `<dir>/<name>.json`.
 */
export function recordingPath(dir: string, name: string): string {
  return join(dir, `${name}.json`);
}

// This package's own `src/` or `dist/` directory, with a trailing separator.
// ESM has no `__dirname`; `import.meta.url` is this file's `file://` URL.
const OWN_DIR = fileURLToPath(new URL("../", import.meta.url));

/**
 * Turns a stack frame's file name into a plain path: strips a `file://`
 * scheme and any `?query` (Vitest and cache-busting imports add one).
 *
 * @param fileName - What `CallSite.getFileName()` returned.
 * @returns The absolute path.
 */
function framePath(fileName: string): string {
  if (fileName.startsWith("file://")) return fileURLToPath(fileName);
  const query = fileName.indexOf("?");
  return query === -1 ? fileName : fileName.slice(0, query);
}

/**
 * Finds the file that called into agent-retrace, which is the test file
 * that called `replay()`. Skips frames from this package, Node internals and
 * `node_modules`.
 *
 * Uses the V8 stack trace API: while `Error.prepareStackTrace` is set, reading
 * `err.stack` passes structured `CallSite` objects to it instead of building
 * a string. `getCallSites` from `node:util` would be simpler but needs Node
 * 22.9 or later.
 *
 * @returns The absolute path of the calling file, or undefined when no frame
 *   qualifies (e.g. called from the REPL or `node -e`).
 */
export function callerTestFile(): string | undefined {
  const originalPrepare = Error.prepareStackTrace;
  const originalLimit = Error.stackTraceLimit;
  let sites: NodeJS.CallSite[] = [];
  try {
    Error.prepareStackTrace = (_err, callSites) => callSites;
    // The default limit of 10 frames can be used up by library and test
    // runner frames before reaching the test file.
    Error.stackTraceLimit = 50;
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder, callerTestFile);
    sites = holder.stack as NodeJS.CallSite[];
  } finally {
    Error.prepareStackTrace = originalPrepare;
    Error.stackTraceLimit = originalLimit;
  }
  for (const site of sites) {
    const fileName = site.getFileName();
    if (!fileName || fileName.startsWith("node:")) continue;
    const path = framePath(fileName);
    // Code run through `node -e` or the REPL reports pseudo names like "[eval]".
    if (!isAbsolute(path)) continue;
    if (path.startsWith(OWN_DIR) || path.includes(`${sep}node_modules${sep}`)) continue;
    return path;
  }
  return undefined;
}

/**
 * Reads a recording file.
 *
 * @param path - Path of the recording file.
 * @param expectedName - The recording name the caller asked for.
 * @returns The recording, or undefined when the file does not exist.
 * @throws {RecordingFormatError} When the file is malformed or holds a
 *   recording with a different name (e.g. "Foo" read as "foo.json" on a
 *   case-insensitive filesystem).
 */
export async function loadRecording(
  path: string,
  expectedName: string,
): Promise<Recording | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    // Node reports file errors through a string `code` property, like
    // Python's `errno`, not through distinct exception classes.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const recording = parseRecording(text, path);
  if (recording.name !== expectedName) {
    throw new RecordingFormatError(
      path,
      `holds recording ${JSON.stringify(recording.name)}, expected ${JSON.stringify(expectedName)}. Names that differ only in case share a file on case-insensitive filesystems, so rename one of them`,
    );
  }
  return recording;
}

/**
 * Writes a recording atomically: the contents go to a temporary file in the
 * same directory, which is then renamed over the target. A run that is
 * interrupted part way leaves the old file or the new one, never half of one.
 *
 * @param path - Path of the recording file. Missing directories are created.
 * @param r - The recording.
 * @throws {Error} When the directory or file cannot be written.
 */
export async function saveRecording(path: string, r: Recording): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, serializeRecording(r), "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
