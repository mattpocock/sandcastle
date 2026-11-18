/**
 * Gives each `vitest` run a private temp directory, and fails the run if a
 * test leaves behind an entry named like Sandcastle's own temp files.
 *
 * Sandcastle creates `$TMPDIR/sandcastle-{bundle,git,copyin}-*` entries at
 * runtime, and the verify ledger (`.sandcastle/verify/ledger.ts`) reports any
 * new one as a leak. A test that leaves one in the shared `$TMPDIR` shows up
 * as a false leak in any world being verified at the same time.
 *
 * This runs once in the main process (via vitest `globalSetup`), before the
 * workers start, so every worker inherits the private `TMPDIR`.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The prefix of each e2e test file's own directory in the run's.
 *
 * Both names are short on purpose: a local sandbox's keeper listens on a Unix
 * socket under the test's temp dir, and a socket path has room for only 107
 * characters. `sc-test-XXXXXX/f-XXXXXX` is no longer than the one directory
 * the run used to have.
 */
export const FILE_DIR_PREFIX = "f-";

/** The prefixes Sandcastle itself uses — keep in sync with the ledger. */
export const SANDCASTLE_TMP_ENTRY = /^sandcastle-(?:bundle|git|copyin)-/u;

/**
 * The Sandcastle temp entries in `dir`, and in the directory each e2e test
 * file has inside it (see tests/helpers/processGuard.ts).
 */
const sandcastleEntriesIn = (dir: string, under = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (
      under === "" &&
      entry.isDirectory() &&
      entry.name.startsWith(FILE_DIR_PREFIX)
    ) {
      return sandcastleEntriesIn(join(dir, entry.name), entry.name);
    }
    return SANDCASTLE_TMP_ENTRY.test(entry.name)
      ? [join(under, entry.name)]
      : [];
  });

export default function setup(): () => void {
  const originalTmpdir = process.env.TMPDIR;
  const runTmpdir = mkdtempSync(join(tmpdir(), "sc-test-"));
  process.env.TMPDIR = runTmpdir;

  return () => {
    const leaked = sandcastleEntriesIn(runTmpdir);
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    rmSync(runTmpdir, { recursive: true, force: true });
    if (leaked.length > 0) {
      throw new Error(
        `Tests left ${leaked.length} Sandcastle temp entr${leaked.length === 1 ? "y" : "ies"} behind ` +
          `(${leaked.join(", ")}). Remove what a test creates in an afterEach/afterAll.`,
      );
    }
  };
}
