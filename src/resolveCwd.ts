import { FileSystem } from "@effect/platform";
import { isAbsolute, join, resolve } from "node:path";
import { Data, Effect } from "effect";

/**
 * Default name of the state directory — the host-repo-relative directory where
 * Sandcastle reads/writes its gitignored runtime artifacts (`.env`,
 * `worktrees/`, and the default `logs/`). Overridable per call via
 * the `stateDir` option.
 */
export const DEFAULT_STATE_DIR = ".sandcastle";

/**
 * Resolve a `stateDir` option value against an anchor directory.
 *
 * - Relative value → joined to `anchor`.
 * - Absolute value → used verbatim (the anchor is ignored).
 *
 * Mirrors {@link resolveCwd}'s relative/absolute handling, but is a pure sync
 * path computation — it does not stat or validate the result.
 */
export const resolveStateDir = (anchor: string, stateDir: string): string =>
  isAbsolute(stateDir) ? stateDir : join(anchor, stateDir);

/** The provided `cwd` path does not exist or is not a directory. */
export class CwdError extends Data.TaggedError("CwdError")<{
  readonly message: string;
  readonly cwd: string;
}> {}

/**
 * Resolve an optional `cwd` string to an absolute, validated host repo directory.
 *
 * - `undefined` → `process.cwd()` (resolved to absolute).
 * - Relative path → resolved against `process.cwd()`.
 * - Absolute path → passed through.
 *
 * Stats the result via Effect's `FileSystem`; fails with {@link CwdError}
 * when the path is missing or is not a directory.
 */
export const resolveCwd = (
  cwd: string | undefined,
): Effect.Effect<string, CwdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolved =
      cwd !== undefined ? resolve(process.cwd(), cwd) : resolve(process.cwd());

    const fs = yield* FileSystem.FileSystem;

    const stat = yield* fs.stat(resolved).pipe(
      Effect.mapError(
        () =>
          new CwdError({
            message: `cwd does not exist: ${resolved}`,
            cwd: resolved,
          }),
      ),
    );
    if (stat.type !== "Directory") {
      return yield* new CwdError({
        message: `cwd is not a directory: ${resolved}`,
        cwd: resolved,
      });
    }

    return resolved;
  });
