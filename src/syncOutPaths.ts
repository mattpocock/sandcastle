/**
 * Path checks for sync-out. An isolated sandbox reports which files to bring
 * back (patch names, untracked paths, patch contents), and everything it
 * reports is untrusted: each host destination must stay inside the host
 * worktree, and out of its `.git`. See `syncOut.ts`.
 */

import type { Stats } from "node:fs";
import { lstat, readlink, realpath } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Effect, Option } from "effect";
import type { SyncOutPathError } from "./errors.js";
import { isAbsoluteAnywhere, isGitSegment, refusal } from "./syncOutRefusal.js";

export { checkPatchFileSymlinks } from "./syncOutPatchSymlinks.js";

const splitSegments = (path: string): string[] =>
  path.split(/[\\/]/u).filter((segment) => segment !== "" && segment !== ".");

const relativePathProblem = (
  path: string,
  segments: readonly string[],
): string | undefined => {
  if (path.includes("\0")) {
    return "it contains a NUL byte";
  }
  if (isAbsoluteAnywhere(path)) {
    return "it is an absolute path";
  }
  if (segments.includes("..")) {
    return "it has a '..' segment";
  }
  if (segments.some((segment) => isGitSegment(segment))) {
    return "it is inside .git";
  }
  return segments.length === 0 ? "it is empty" : undefined;
};

/**
 * Normalises a sandbox-reported path relative to the worktree into its
 * segments. Refuses an absolute path, a `..` segment, a `.git` segment, and
 * an empty path. Both `/` and `\` count as separators.
 */
export const checkRelativePath = (
  path: string,
): Effect.Effect<string[], SyncOutPathError> => {
  const segments = splitSegments(path);
  const problem = relativePathProblem(path, segments);
  return problem === undefined
    ? Effect.succeed(segments)
    : Effect.fail(refusal(path, problem));
};

/** A patch file name: one path segment, nothing that climbs out. */
export const checkPatchName = (
  name: string,
): Effect.Effect<string, SyncOutPathError> =>
  /[\\/\0]/u.test(name) || name === "." || name === ".." || name === ""
    ? Effect.fail(refusal(name, "a patch name must be a single file name"))
    : Effect.succeed(name);

/** A node fs call as an Effect; any error becomes `None`. */
const attempt = <A>(
  call: (done: (error: Error | null, value: A) => void) => void,
): Effect.Effect<Option.Option<A>> =>
  Effect.async((resume) => {
    call((error, value) => {
      resume(
        Effect.succeed(error === null ? Option.some(value) : Option.none()),
      );
    });
  });

const lstatOf = (p: string) =>
  attempt<Stats>((done) => {
    lstat(p, done);
  });

const realPathOf = (p: string) =>
  attempt<string>((done) => {
    realpath(p, done);
  });

const readLinkOf = (p: string) =>
  attempt<string>((done) => {
    readlink(p, done);
  });

/** The real path of the host worktree, every later check's anchor. */
export const realRootOf = (
  dir: string,
): Effect.Effect<string, SyncOutPathError> =>
  realPathOf(dir).pipe(
    Effect.flatMap((real) =>
      Option.isSome(real)
        ? Effect.succeed(real.value)
        : Effect.fail(refusal(dir, "the host worktree can't be resolved")),
    ),
  );

/** The deepest prefix of `segments` under `root` that exists (as a link or not). */
const deepestExisting = (
  root: string,
  segments: readonly string[],
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    for (let depth = segments.length; depth > 0; depth--) {
      const candidate = join(root, ...segments.slice(0, depth));
      if (Option.isSome(yield* lstatOf(candidate))) {
        return Option.some(candidate);
      }
    }
    return Option.none();
  });

const isOutside = (rel: string): boolean =>
  rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/** Fails unless `existing` resolves inside `realRoot` and outside its `.git`. */
const checkResolvesInside = (
  realRoot: string,
  relPath: string,
  existing: string,
): Effect.Effect<void, SyncOutPathError> =>
  Effect.gen(function* () {
    const real = yield* realPathOf(existing);
    if (Option.isNone(real)) {
      return yield* refusal(relPath, `${existing} is a symlink to nowhere`);
    }
    const rel = relative(realRoot, real.value);
    if (isOutside(rel)) {
      return yield* refusal(relPath, `${existing} leads outside the worktree`);
    }
    if (splitSegments(rel).some((segment) => isGitSegment(segment))) {
      return yield* refusal(relPath, `${existing} leads inside .git`);
    }
  });

/**
 * The host path to write `relPath` to, under `realRoot` (already a real
 * path). Checks the path with {@link checkRelativePath}, then resolves
 * symlinks on the host: the deepest part of the destination that already
 * exists must resolve inside `realRoot` and outside its `.git`. A symlink
 * that leads out, or nowhere, is refused rather than followed.
 */
export const resolveHostDestination = (
  realRoot: string,
  relPath: string,
): Effect.Effect<string, SyncOutPathError> =>
  Effect.gen(function* () {
    const segments = yield* checkRelativePath(relPath);
    const existing = yield* deepestExisting(realRoot, segments);
    if (Option.isSome(existing)) {
      yield* checkResolvesInside(realRoot, relPath, existing.value);
    }
    return join(realRoot, ...segments);
  });

/** Fails unless the file sync-out staged for `relPath` is a regular file. */
export const checkStagedFile = (
  staged: string,
  relPath: string,
): Effect.Effect<void, SyncOutPathError> =>
  lstatOf(staged).pipe(
    Effect.flatMap((stat) =>
      Option.isSome(stat) && stat.value.isFile()
        ? Effect.void
        : Effect.fail(refusal(relPath, "it is not a regular file")),
    ),
  );

/** The target of the host symlink at `relPath` under `realRoot`, if it is one. */
export const hostSymlinkAt =
  (realRoot: string) =>
  (relPath: string): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const p = join(realRoot, ...splitSegments(relPath));
      const stat = yield* lstatOf(p);
      return Option.isSome(stat) && stat.value.isSymbolicLink()
        ? yield* readLinkOf(p)
        : Option.none();
    });
