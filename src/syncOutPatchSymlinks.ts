/**
 * Which symlinks a sandbox's patches would make on the host, and whether
 * each one stays inside the worktree. See `syncOut.ts`.
 *
 * A patch can create a symlink with any target. Git applies it, and a later
 * write through it (by sync-out, or anything else) would land wherever it
 * points. So before sync-out applies anything, every symlink the patches
 * create, retarget, rename or copy must point inside the worktree and
 * outside its `.git`.
 */

import { readFile } from "node:fs";
import { posix } from "node:path";
import { Effect, Option } from "effect";
import type { SyncOutPathError } from "./errors.js";
import type { FileChange } from "./patchFileChanges.js";
import { parsePatch } from "./patchFileChanges.js";
import { isAbsoluteAnywhere, isGitSegment, refusal } from "./syncOutRefusal.js";

/**
 * Fails unless the symlink `linkPath` (relative to the worktree) pointing
 * at `target` stays inside the worktree and outside its `.git`. Lexical:
 * the target is resolved against the link's own directory.
 */
const checkSymlinkTarget = (
  linkPath: string,
  target: string,
): Effect.Effect<void, SyncOutPathError> => {
  if (target === "" || target.includes("\0")) {
    return Effect.fail(refusal(linkPath, "it is a symlink with no target"));
  }
  if (isAbsoluteAnywhere(target)) {
    return Effect.fail(refusal(linkPath, `it is a symlink to ${target}`));
  }
  const resolved = posix.normalize(
    posix.join(posix.dirname(linkPath), target.replaceAll("\\", "/")),
  );
  if (resolved === ".." || resolved.startsWith("../")) {
    return Effect.fail(
      refusal(linkPath, `it is a symlink to ${target}, outside the worktree`),
    );
  }
  return resolved.split("/").some((segment) => isGitSegment(segment))
    ? Effect.fail(refusal(linkPath, `it is a symlink to ${target}, in .git`))
    : Effect.void;
};

/** The symlink target at a path: what a patch made, or what the host has. */
export type SymlinkLookup = (
  relPath: string,
) => Effect.Effect<Option.Option<string>>;

/** Where a symlink change points, when it can be told. */
const targetOf = (
  change: FileChange,
  symlinkAt: SymlinkLookup,
): Effect.Effect<Option.Option<string>> => {
  if (change.newLines.length > 0) {
    // A symlink's content is one line: its target.
    return Effect.succeed(
      change.newLines.length === 1
        ? Option.fromNullable(change.newLines[0])
        : Option.none(),
    );
  }
  return change.from === undefined
    ? Effect.succeed(Option.none())
    : symlinkAt(change.from);
};

/**
 * Checks one file change, given what is known of symlinks so far; succeeds
 * with the symlink target now at its path (`None` if it is not one).
 */
const checkChange = (
  change: FileChange,
  path: string,
  symlinkAt: SymlinkLookup,
): Effect.Effect<Option.Option<string>, SyncOutPathError> =>
  Effect.gen(function* () {
    // A pure rename or copy keeps the type, so a symlink stays one.
    const keepsType = !change.symlink && change.newLines.length === 0;
    if (!change.symlink && !(keepsType && change.from !== undefined)) {
      return Option.none();
    }
    if (change.binary || change.modeOnly) {
      return yield* refusal(path, "a symlink whose target can't be checked");
    }
    const target = yield* targetOf(change, symlinkAt);
    if (Option.isNone(target)) {
      return change.symlink
        ? yield* refusal(path, "a symlink whose target can't be checked")
        : Option.none();
    }
    yield* checkSymlinkTarget(path, target.value);
    return target;
  });

/**
 * Checks every symlink a series of patches would create or change points
 * inside the worktree and outside its `.git`. Patches are read in order, so
 * a symlink one patch makes is known to the next; anything else is looked up
 * on the host with `hostSymlinkAt`.
 */
export const checkPatchSymlinks = (
  patches: readonly string[],
  hostSymlinkAt: SymlinkLookup,
): Effect.Effect<void, SyncOutPathError> =>
  Effect.gen(function* () {
    const made = new Map<string, Option.Option<string>>();
    const symlinkAt: SymlinkLookup = (relPath) =>
      Option.match(Option.fromNullable(made.get(relPath)), {
        onNone: () => hostSymlinkAt(relPath),
        onSome: (known) => Effect.succeed(known),
      });
    for (const change of patches.flatMap((patch) => parsePatch(patch))) {
      const path = change.deleted
        ? (change.path ?? change.oldPath)
        : change.path;
      if (path === undefined) {
        if (change.symlink) {
          return yield* refusal("(unknown)", "a symlink with no path");
        }
        continue;
      }
      made.set(
        path,
        change.deleted
          ? Option.none()
          : yield* checkChange(change, path, symlinkAt),
      );
    }
  });

/** {@link checkPatchSymlinks} for the patch files at `paths`. */
export const checkPatchFileSymlinks = (
  paths: readonly string[],
  hostSymlinkAt: SymlinkLookup,
): Effect.Effect<void, SyncOutPathError> =>
  Effect.gen(function* () {
    const patches = yield* Effect.all(
      paths.map((path) =>
        Effect.async<string, SyncOutPathError>((resume) => {
          readFile(path, "utf8", (error, text) => {
            resume(
              error === null
                ? Effect.succeed(text)
                : Effect.fail(refusal(path, "the patch can't be read")),
            );
          });
        }),
      ),
    );
    yield* checkPatchSymlinks(patches, hostSymlinkAt);
  });
