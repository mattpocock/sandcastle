import { FileSystem } from "@effect/platform";
import { resolve } from "node:path";
import { Data, Effect } from "effect";

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
 *
 * Returns the directory's real path, with symlinks resolved. Claude Code
 * names its session directory after the physical path of its working
 * directory, so a repo reached through a symlink (macOS's `/tmp` →
 * `/private/tmp`, for instance) must be named the same way, or session
 * capture and resume look in the wrong place. Resolving here, once, means
 * the worktree and sandbox paths derived from the repo dir are physical too.
 */
export const resolveCwd = (
  cwd: string | undefined,
): Effect.Effect<string, CwdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resolved =
      cwd === undefined ? resolve(process.cwd()) : resolve(process.cwd(), cwd);

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

    return yield* fs.realPath(resolved).pipe(
      Effect.mapError(
        () =>
          new CwdError({
            message: `cwd could not be resolved: ${resolved}`,
            cwd: resolved,
          }),
      ),
    );
  });
