/**
 * Vitest configuration: a `unit` project for the library tests and an
 * `example` project for the offline support-agent example.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/**/*.test.ts"] } },
      {
        test: {
          name: "example",
          root: "examples/support-agent",
          include: ["**/*.test.ts"],
        },
      },
    ],
  },
});
