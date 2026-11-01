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

/** Each state dir an entry point resolved, mapped to the repo it serves. */
const stateDirRepos = new Map<string, string>();

/**
 * Resolve a `stateDir` option value against an anchor directory.
 *
 * - Relative value → joined to `anchor`.
 * - Absolute value → used verbatim (the anchor is ignored).
 *
 * Mirrors {@link resolveCwd}'s relative/absolute handling. It does not stat or
 * validate the result. Every entry point resolves its state dir through here
 * once, so it also records that the state dir belongs to `anchor` (the host
 * repo): the host git guard reads that back to recognise the managed worktrees
 * under it (see {@link stateDirRepo}).
 */
export const resolveStateDir = (anchor: string, stateDir: string): string => {
  const resolved = isAbsolute(stateDir) ? stateDir : join(anchor, stateDir);
  stateDirRepos.set(resolve(resolved), resolve(anchor));
  return resolved;
};

/** The host repo a resolved state dir belongs to, if an entry point resolved it. */
export const stateDirRepo = (stateDir: string): string | undefined =>
  stateDirRepos.get(resolve(stateDir));

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

    return resolved;
  });
