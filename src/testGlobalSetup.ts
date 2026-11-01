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

/** The prefixes Sandcastle itself uses — keep in sync with the ledger. */
export const SANDCASTLE_TMP_ENTRY = /^sandcastle-(bundle|git|copyin)-/u;

export default function setup(): () => void {
  const originalTmpdir = process.env.TMPDIR;
  const runTmpdir = mkdtempSync(join(tmpdir(), "sandcastle-vitest-"));
  process.env.TMPDIR = runTmpdir;

  return () => {
    const leaked = readdirSync(runTmpdir).filter((name) =>
      SANDCASTLE_TMP_ENTRY.test(name),
    );
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
