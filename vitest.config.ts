import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      ".sandcastle/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // `sandcastle` checks out worktrees under .sandcastle/worktrees/, each a
    // full copy of the repo. Their tests are not this checkout's tests.
    exclude: [...configDefaults.exclude, ".sandcastle/worktrees/**"],
    setupFiles: ["src/testSetup.ts"],
    globalSetup: ["src/testGlobalSetup.ts"],
  },
});
