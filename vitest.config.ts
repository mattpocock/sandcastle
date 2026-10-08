import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@vercel/sandbox": fileURLToPath(
        new URL("./src/test-fixtures/vercel-sandbox.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts", ".sandcastle/**/*.test.ts"],
    setupFiles: ["src/testSetup.ts"],
  },
});
