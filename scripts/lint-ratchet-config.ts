// The reviewed exceptions to the lint ratchet. Everything not named here is
// either clean or debt in scripts/lint-baseline.json. Changing this file
// widens the straitjacket, so it needs a reason a reviewer agrees with.

export interface Exemption {
  readonly files: readonly string[];
  readonly rules: readonly string[];
  readonly why: string;
}

/** Effect is run only here. Mirrors the first override in .oxlintrc.json. */
export const ENTRY_POINTS: readonly string[] = [
  "src/main.ts",
  "src/run.ts",
  "src/interactive.ts",
  "src/createSandbox.ts",
  "src/createWorktree.ts",
  "src/sandboxes/*.ts",
];

/** Mirrors the second override in .oxlintrc.json. */
export const TEST_FILES: readonly string[] = [
  "**/*.test.ts",
  "src/testSetup.ts",
  "src/testSandbox.ts",
];

/**
 * Effect diagnostics that do not apply where they are reported. The language
 * service has no per-file config, so these live here.
 */
export const EFFECT_EXEMPTIONS: readonly Exemption[] = [
  {
    files: ENTRY_POINTS,
    rules: ["asyncFunction", "strictEffectProvide"],
    why: "the public API is promise-based and provides the layers",
  },
  {
    files: TEST_FILES,
    rules: [
      "asyncFunction",
      "strictEffectProvide",
      "nodeBuiltinImport",
      "newPromise",
      "preferSchemaOverJson",
      "processEnv",
      "processEnvInEffect",
      "globalConsole",
      "globalConsoleInEffect",
      "globalDate",
      "globalDateInEffect",
      "globalRandom",
      "globalRandomInEffect",
      "globalTimers",
      "globalTimersInEffect",
    ],
    why: "vitest tests are async functions that set up the world directly",
  },
  {
    files: ["src/templates/**/*"],
    rules: ["globalConsole"],
    why: "templates are scripts users scaffold and run; console is their output",
  },
  {
    files: ["src/sandboxes/**/*"],
    rules: ["newPromise"],
    why: "sandbox providers wrap Node child processes and SDK callbacks in promises",
  },
];

/**
 * Inline directives that are allowed. Any other disable, enable, ts-ignore,
 * ts-expect-error or effect-diagnostics comment counts as
 * `ratchet/disable-comment`.
 */
export const ALLOWED_DIRECTIVES: readonly Exemption[] = [
  {
    files: TEST_FILES,
    rules: ["@ts-expect-error"],
    why: "type-level tests assert that an option is rejected",
  },
];
