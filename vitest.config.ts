import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Alias @ai-hero/sandcastle subpath imports first (more specific match)
      "@ai-hero/sandcastle/sandboxes/docker": resolve(
        __dirname,
        "src/sandboxes/docker.ts",
      ),
      "@ai-hero/sandcastle/sandboxes/podman": resolve(
        __dirname,
        "src/sandboxes/podman.ts",
      ),
      "@ai-hero/sandcastle/sandboxes/no-sandbox": resolve(
        __dirname,
        "src/sandboxes/no-sandbox.ts",
      ),
      // Alias the main package to the test-support module
      "@ai-hero/sandcastle": resolve(__dirname, "src/testSupport.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/globalSetup.ts"],
  },
});
