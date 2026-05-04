import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: false,
    passWithNoTests: false,
  },
});
