// Import boundaries for the end-to-end tests. Run by `npm run lint`, and held
// to scripts/test-baseline.json by the test ratchet (scripts/lint-ratchet.ts).
// See .sandcastle/CODING_STANDARDS.md, "Where tests live".

import { fileURLToPath } from "node:url";

/** The files behind package.json `exports`: the public API. */
const ENTRY_POINTS =
  "^src/(index|sandboxes/(docker|vercel|podman|daytona|no-sandbox|bwrap|seatbelt))[.]ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: "tests-only-public-api",
      comment:
        "tests/ sees Sandcastle the way a user does: through the package entry points, imported by package name (@ai-hero/sandcastle, @ai-hero/sandcastle/sandboxes/*), and other files under tests/.",
      severity: "error",
      from: { path: "^tests/" },
      to: {
        dependencyTypesNot: [
          "npm",
          "npm-dev",
          "npm-optional",
          "npm-peer",
          "core",
        ],
        pathNot: [ENTRY_POINTS, "^tests/"],
      },
    },
    {
      name: "tests-import-by-package-name",
      comment:
        "Import the entry points by package name, not by a relative path into src/.",
      severity: "error",
      from: { path: "^tests/" },
      to: {
        path: ENTRY_POINTS,
        dependencyTypesNot: ["aliased-tsconfig-paths"],
      },
    },
    {
      name: "src-not-from-tests",
      comment: "Shipped code never imports from tests/.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^tests/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(node_modules|dist)/" },
    // tests/tsconfig.json maps the package name to the src entry files, as
    // vitest.config.ts does at run time.
    // Absolute: TypeScript resolves `extends` wrongly from a relative name.
    tsConfig: {
      fileName: fileURLToPath(new URL("tests/tsconfig.json", import.meta.url)),
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".mjs", ".json"],
    },
  },
};

export default config;
