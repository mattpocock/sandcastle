/**
 * Checks where a working directory's `.git` leads before git runs on the host
 * there. See `hostGit.ts`.
 */

import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { HostGitError } from "./errors.js";

const refusal = (args: readonly string[], message: string): HostGitError =>
  new HostGitError({
    message: `Refusing to run git on the host: ${message}`,
    args,
    stdout: "",
    stderr: "",
  });

/** A node fs call as an Effect, failing with a refusal that names `what`. */
const fsCall = <A>(
  args: readonly string[],
  what: string,
  call: (done: (error: Error | null, value: A) => void) => void,
): Effect.Effect<A, HostGitError> =>
  Effect.async((resume) => {
    call((error, value) => {
      resume(
        error === null
          ? Effect.succeed(value)
          : Effect.fail(refusal(args, `${what}: ${error.message}`)),
      );
    });
  });

const realPath = (args: readonly string[], p: string) =>
  fsCall<string>(args, `cannot resolve ${p}`, (done) => {
    realpath(p, done);
  });

const readText = (args: readonly string[], p: string) =>
  fsCall<string>(args, `cannot read ${p}`, (done) => {
    readFile(p, "utf8", done);
  });

const statOf = (args: readonly string[], p: string) =>
  fsCall<Stats>(args, `cannot stat ${p}`, (done) => {
    lstat(p, done);
  });

/** A worktree Sandcastle created: `<repo>/.sandcastle/worktrees/<name>`. */
const isManagedWorktree = (dir: string): boolean => {
  const parent = dirname(resolve(dir));
  return (
    basename(parent) === "worktrees" &&
    basename(dirname(parent)) === ".sandcastle"
  );
};

const GITDIR_LINE = /^gitdir: (?<path>.+)$/u;

interface LinkedWorktreeDirs {
  readonly gitDir: string;
  readonly commonDir: string;
}

/**
 * Follows a linked worktree's `.git` file and checks it has git's layout:
 * the gitdir is `<common dir>/worktrees/<name>` and its `commondir` file
 * leads back to that same common dir.
 */
const readLinkedWorktree = (
  args: readonly string[],
  dir: string,
): Effect.Effect<LinkedWorktreeDirs, HostGitError> =>
  Effect.gen(function* () {
    const dotGit = join(dir, ".git");
    const pointer = yield* readText(args, dotGit);
    const path = GITDIR_LINE.exec(pointer.trim())?.groups?.["path"];
    if (path === undefined) {
      return yield* refusal(args, `${dotGit} is not a gitdir pointer`);
    }
    const gitDir = yield* realPath(args, resolve(dir, path));
    const commondir = yield* readText(args, join(gitDir, "commondir"));
    const commonDir = yield* realPath(args, resolve(gitDir, commondir.trim()));
    const layoutParent = yield* realPath(args, dirname(dirname(gitDir)));
    if (
      basename(dirname(gitDir)) !== "worktrees" ||
      layoutParent !== commonDir
    ) {
      return yield* refusal(
        args,
        `${dotGit} points at ${gitDir}, which is not a worktree of ${commonDir}`,
      );
    }
    return { gitDir, commonDir };
  });

/** The git common dir of the repository whose top level is `repoDir`. */
const commonDirOf = (
  args: readonly string[],
  repoDir: string,
): Effect.Effect<string, HostGitError> =>
  Effect.gen(function* () {
    const dotGit = join(repoDir, ".git");
    const stat = yield* statOf(args, dotGit);
    if (stat.isDirectory()) {
      return yield* realPath(args, dotGit);
    }
    const linked = yield* readLinkedWorktree(args, repoDir);
    return linked.commonDir;
  });

/** Environment pinning git to a repository's git dirs. */
export type GitDirPins = Readonly<Record<string, string>>;

/**
 * Validates `cwd`'s `.git` before host git runs there, and returns the
 * environment that pins git to it. A normal repo needs no pins. A linked
 * worktree must have git's layout (see `readLinkedWorktree`), a worktree
 * under `.sandcastle/worktrees/` must also belong to the repo it sits in, and
 * both are pinned with `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` so git
 * never re-reads the pointer files.
 */
export const resolveGitDirPins = (
  cwd: string,
  args: readonly string[],
): Effect.Effect<GitDirPins, HostGitError> =>
  Effect.gen(function* () {
    const dotGit = join(cwd, ".git");
    const managed = isManagedWorktree(cwd);
    const stat = yield* statOf(args, dotGit).pipe(Effect.option);
    if (stat._tag === "None" || stat.value.isDirectory()) {
      if (managed) {
        return yield* refusal(args, `${dotGit} is not a worktree's .git file`);
      }
      const none: GitDirPins = {};
      return none;
    }
    if (!stat.value.isFile()) {
      return yield* refusal(args, `${dotGit} is not a regular file`);
    }
    const dirs = yield* readLinkedWorktree(args, cwd);
    if (managed) {
      const repoDir = dirname(dirname(dirname(resolve(cwd))));
      const expected = yield* commonDirOf(args, repoDir);
      if (dirs.commonDir !== expected) {
        return yield* refusal(
          args,
          `${dotGit} leads to ${dirs.commonDir}, not to ${expected}`,
        );
      }
    }
    return {
      GIT_DIR: dirs.gitDir,
      GIT_COMMON_DIR: dirs.commonDir,
      GIT_WORK_TREE: cwd,
    };
  });
