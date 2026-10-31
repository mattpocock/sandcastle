/**
 * Read-only overlays for the git files a bind-mount sandbox must not write.
 *
 * The sandbox needs the host repo's `.git` writable to commit (objects, refs,
 * the worktree's admin dir). But `config`, `hooks` and `info` there, the
 * worktree's `.git` pointer file and its `commondir` decide what git commands
 * on the host read and run. Each one is mounted again, read-only, at every
 * place it is visible inside the sandbox.
 */

import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { Effect, Option } from "effect";

/** A bind mount as passed to a bind-mount provider. */
export interface GitMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

const GITDIR_LINE = /^gitdir: (?<path>.+)$/u;

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

const realPath = (p: string) =>
  attempt<string>((done) => {
    realpath(p, done);
  });

const readText = (p: string) =>
  attempt<string>((done) => {
    readFile(p, "utf8", done);
  });

const statOf = (p: string) =>
  attempt<Stats>((done) => {
    lstat(p, done);
  });

const ensureDir = (p: string) =>
  attempt<string | undefined>((done) => {
    mkdir(p, { recursive: true }, done);
  });

const toMountPath = (p: string): string =>
  process.platform === "win32" ? p.replaceAll("\\", "/") : p;

/** `child` relative to `parent` ("" when equal), or `None` if outside it. */
const relativeWithin = (
  child: string,
  parent: string,
): Option.Option<string> => {
  const rel = relative(parent, child);
  return rel.startsWith("..") || isAbsolute(rel)
    ? Option.none()
    : Option.some(rel);
};

/** `config`, `hooks` and `info` of a common dir; the dirs are created if missing. */
const commonDirControlPaths = (commonDir: string) =>
  Effect.gen(function* () {
    yield* ensureDir(join(commonDir, "hooks"));
    yield* ensureDir(join(commonDir, "info"));
    return ["config", "hooks", "info"].map((name) => join(commonDir, name));
  });

/** The control paths of a linked worktree whose `.git` file says `gitdir`. */
const linkedWorktreeControlPaths = (dir: string, gitdir: string) =>
  Effect.gen(function* () {
    const dotGit = yield* realPath(join(dir, ".git"));
    const adminDir = yield* realPath(resolve(dir, gitdir));
    if (Option.isNone(dotGit) || Option.isNone(adminDir)) {
      return [];
    }
    const commondirFile = join(adminDir.value, "commondir");
    const commondir = yield* readText(commondirFile);
    if (Option.isNone(commondir)) {
      return [dotGit.value];
    }
    const commonDir = yield* realPath(
      resolve(adminDir.value, commondir.value.trim()),
    );
    return [
      dotGit.value,
      commondirFile,
      ...(Option.isSome(commonDir)
        ? yield* commonDirControlPaths(commonDir.value)
        : []),
    ];
  });

/** The control paths of the repo or worktree at `dir`, as real host paths. */
const controlPathsOf = (dir: string): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const dotGit = join(dir, ".git");
    const stat = yield* statOf(dotGit);
    if (Option.isNone(stat)) {
      return [];
    }
    if (stat.value.isDirectory()) {
      const real = yield* realPath(dotGit);
      return Option.isSome(real)
        ? yield* commonDirControlPaths(real.value)
        : [];
    }
    const pointer = yield* readText(dotGit);
    const gitdir = pointer.pipe(
      Option.flatMap((text) =>
        Option.fromNullable(GITDIR_LINE.exec(text.trim())?.groups?.["path"]),
      ),
    );
    return Option.isSome(gitdir)
      ? yield* linkedWorktreeControlPaths(dir, gitdir.value)
      : [];
  });

/** Every repo whose `.git` the sandbox sees: the workspace, and any `.git` file mounted on its own. */
const reposOf = (
  mounts: readonly GitMount[],
  worktreeOrRepoPath: string,
): string[] => [
  ...new Set([
    worktreeOrRepoPath,
    ...mounts
      .filter((m) => posix.basename(toMountPath(m.hostPath)) === ".git")
      .map((m) => dirname(m.hostPath)),
  ]),
];

/** Marks the mount at `sandboxPath` read-only, or adds one for `hostPath`. */
const protectAt = (
  result: GitMount[],
  hostPath: string,
  sandboxPath: string,
): GitMount[] =>
  result.some((m) => m.sandboxPath === sandboxPath)
    ? result.map((m) =>
        m.sandboxPath === sandboxPath ? { ...m, readonly: true } : m,
      )
    : [
        ...result,
        { hostPath: toMountPath(hostPath), sandboxPath, readonly: true },
      ];

/**
 * Adds a read-only mount for each git control path at every sandbox path it
 * is visible at, and marks mounts that already target one read-only. Missing
 * or unreadable git metadata is skipped: git on the host can't read it
 * either.
 */
export const protectGitControlFiles = (
  mounts: readonly GitMount[],
  worktreeOrRepoPath: string,
): Effect.Effect<GitMount[]> =>
  Effect.gen(function* () {
    const controlPaths = new Set(
      (yield* Effect.forEach(reposOf(mounts, worktreeOrRepoPath), (repo) =>
        controlPathsOf(repo),
      )).flat(),
    );
    const withRealPaths = yield* Effect.all(
      mounts.map((mount) =>
        realPath(mount.hostPath).pipe(Effect.map((real) => ({ mount, real }))),
      ),
    );
    let result: GitMount[] = mounts.map((m) => ({
      hostPath: m.hostPath,
      sandboxPath: m.sandboxPath,
      readonly: m.readonly,
    }));
    for (const controlPath of controlPaths) {
      for (const { mount, real } of withRealPaths) {
        const rel = real.pipe(
          Option.flatMap((path) => relativeWithin(controlPath, path)),
        );
        if (Option.isSome(rel)) {
          const sandboxPath =
            rel.value === ""
              ? mount.sandboxPath
              : posix.join(mount.sandboxPath, toMountPath(rel.value));
          result = protectAt(result, controlPath, sandboxPath);
        }
      }
    }
    return result;
  });
