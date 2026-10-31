import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      ".sandcastle/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    setupFiles: ["src/testSetup.ts"],
    globalSetup: ["src/testGlobalSetup.ts"],
  },
});
