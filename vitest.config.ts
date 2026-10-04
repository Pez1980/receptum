import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/scripts/**/*.test.mjs",
      "examples/*/src/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
  },
});
