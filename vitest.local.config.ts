import { configDefaults, defineConfig } from "vitest/config";
import { LOCAL_TESTS } from "./scripts/lint-ratchet-config.ts";
import { coverage, entryAliases, setupFiles } from "./vitest.config.ts";

// The local tests (`npm run test:local`): tests/local/, against real Docker
// and Podman. Never part of `npm test` or CI, which have no container engine;
// run before every release (docs/agents/releasing.md).
//
// tests/local/globalSetup.ts fails the run when an engine is missing, and
// builds the one shared test image per engine. SANDCASTLE_LOCAL_ENGINES
// narrows the run to some engines (e.g. `docker`); a narrowed run does not
// clear a release.

export default defineConfig({
  resolve: { alias: entryAliases },
  test: {
    // The root config's private TMPDIR first, so the image build and every
    // test use it.
    globalSetup: ["src/testGlobalSetup.ts", "tests/local/globalSetup.ts"],
    coverage,
    include: [...LOCAL_TESTS],
    exclude: [...configDefaults.exclude],
    setupFiles,
    // Starting a container takes a second or so; podman more.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
