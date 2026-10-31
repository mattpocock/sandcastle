import { access } from "node:fs/promises";
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };
import { E2E_TESTS, TOOLING_TESTS } from "./scripts/lint-ratchet-config.ts";

// Three projects:
//
// - e2e:     tests/, the end-to-end tests. They import Sandcastle by package
//            name only; the alias below points each name at its src entry,
//            so they run against the source without a build.
// - tooling: tests of the repo's own scripts (scripts/, .sandcastle/). Not
//            part of the package, so out of scope for the e2e move.
// - legacy:  the unit tests next to the code in src/. They move to tests/
//            under the test ratchet (scripts/lint-ratchet.ts) and only shrink.
//
// The e2e and tooling globs live in scripts/lint-ratchet-config.ts, which the
// test ratchet reads too.

/** `@ai-hero/sandcastle` -> src/index.ts, `…/sandboxes/docker` -> src/sandboxes/docker.ts. */
const entryAliases = await Promise.all(
  Object.keys(pkg.exports).map(async (subpath) => {
    const file = path.resolve(
      subpath === "." ? "src/index.ts" : `src/${subpath.slice(2)}.ts`,
    );
    await access(file).catch(() => {
      throw new Error(`package.json exports "${subpath}" has no ${file}`);
    });
    const name = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
    return {
      find: new RegExp(`^${name.replaceAll("/", String.raw`\/`)}$`, "u"),
      replacement: file,
    };
  }),
);

export default defineConfig({
  test: {
    setupFiles: ["src/testSetup.ts"],
    globalSetup: ["src/testGlobalSetup.ts"],
    projects: [
      {
        extends: true,
        resolve: { alias: entryAliases },
        test: { name: "e2e", include: [...E2E_TESTS] },
      },
      {
        extends: true,
        test: {
          name: "tooling",
          include: [...TOOLING_TESTS],
          // `sandcastle` checks out worktrees under .sandcastle/worktrees/,
          // each a full copy of the repo. Their tests are not ours.
          exclude: [...configDefaults.exclude, ".sandcastle/worktrees/**"],
        },
      },
      {
        extends: true,
        test: { name: "legacy", include: ["src/**/*.test.ts"] },
      },
    ],
  },
});
