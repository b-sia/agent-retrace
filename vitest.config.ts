/**
 * Vitest configuration: a `unit` project for the library tests and an
 * `example` project for the offline support-agent example.
 */
import { defineConfig } from "vitest/config";
import { resolveMode } from "./src/config.js";

// Replays finish in milliseconds, but recording makes several real model
// calls per test, which takes far longer than the 5s default. Only modes that
// can record get the long timeout, so a hung replay (on CI, say) still fails
// in seconds instead of minutes.
const exampleTimeout = resolveMode() === "replay" ? undefined : 180_000;

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/**/*.test.ts"] } },
      {
        test: {
          name: "example",
          root: "examples/support-agent",
          include: ["**/*.test.ts"],
          testTimeout: exampleTimeout,
        },
      },
    ],
  },
});
