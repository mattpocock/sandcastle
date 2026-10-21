import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      ".sandcastle/**/*.test.ts",
      "docs/**/*.test.ts",
    ],
    setupFiles: ["src/testSetup.ts"],
  },
});
