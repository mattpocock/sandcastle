import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/testSetup.ts"],
    testTimeout: 30_000,
  },
});
