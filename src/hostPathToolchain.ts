/**
 * Resolves the host toolchain a native sandbox provider should make readable,
 * from the host `PATH`: every `PATH` dir, plus the install root of each
 * executable symlinked from those dirs (an nvm-installed `codex`, a `claude`
 * symlinked into `~/.local/bin`). A dir equal to the home dir or an ancestor
 * of it is refused, so the toolchain never exposes the whole home, and an
 * install root that holds a `.git` is refused, so it never exposes a repo.
 *
 * Provider-agnostic: it takes paths and returns paths. Shared by the native
 * sandbox providers.
 */

import { homedir } from "node:os";
import { posix } from "node:path";
import { FileSystem } from "@effect/platform";
import { Config, Effect, Option } from "effect";

/** What to resolve the toolchain from. */
export interface HostPathToolchainInput {
  /** The host `PATH`. */
  readonly path: string;
  /** The host home dir: it and its ancestors are never made readable. */
  readonly home: string;
  /** Dirs the sandbox already shows: nothing inside them is returned to mount. */
  readonly coveredRoots: readonly string[];
  /** Dirs that must stay hidden: `PATH` dirs and install roots inside them are refused. */
  readonly deniedRoots: readonly string[];
}

/** The toolchain a sandbox needs, all at host paths. */
export interface HostPathToolchain {
  /** The `PATH` for the sandboxed child: the host `PATH` dirs it can see, in order. */
  readonly pathEntries: readonly string[];
  /** Real dirs to make readable at their own paths. */
  readonly readableDirs: readonly string[];
  /** `PATH` dirs that are symlinks on the host, to recreate pointing at their real dir. */
  readonly symlinks: readonly {
    readonly path: string;
    readonly target: string;
  }[];
}

const isWithin = (path: string, root: string): boolean =>
  root === "/" || path === root || path.startsWith(`${root}/`);

const isWithinAny = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => isWithin(path, root));

/** True for the home dir itself and every ancestor of it, `/` included. */
const isHomeOrAncestor = (path: string, home: string): boolean =>
  isWithin(home, path);

const normalizeEntry = (entry: string): string => {
  const normalized = posix.normalize(entry);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const realPathOf = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<string>> => Effect.option(fs.realPath(path));

/** True when `dir` sits inside a `node_modules` tree. */
const isInNodeModules = (dir: string): boolean =>
  dir.split("/").includes("node_modules");

/**
 * The install root of an executable's real file: the nearest ancestor holding
 * a `package.json` inside a `node_modules` tree (a globally installed Node
 * package's bin pulls in its own files), else the file's dir. A `package.json`
 * outside `node_modules` (an `npm link`ed checkout, a stray one above a
 * projects dir) is not an install root: mounting it would expose a project.
 * The search stops below the home dir.
 */
const installRootOf = (
  fs: FileSystem.FileSystem,
  file: string,
  home: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const fileDir = posix.dirname(file);
    let dir = fileDir;
    while (isInNodeModules(dir) && !isHomeOrAncestor(dir, home)) {
      const hasPackageJson = yield* fs
        .exists(posix.join(dir, "package.json"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasPackageJson) {
        return dir;
      }
      dir = posix.dirname(dir);
    }
    return fileDir;
  });

/** True when `dir` holds a `.git`: a repo's checkout is never an install root. */
const isRepoRoot = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<boolean> =>
  fs.exists(posix.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false));

/** The real files behind the symlinks directly inside `dir`. */
const symlinkTargetsIn = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): string[] => []));
    const targets = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const entry = posix.join(dir, name);
          const link = yield* Effect.option(fs.readLink(entry));
          return Option.isSome(link)
            ? yield* realPathOf(fs, entry)
            : Option.none<string>();
        }),
      { concurrency: 32 },
    );
    return targets.flatMap((t) => (Option.isSome(t) ? [t.value] : []));
  });

/** The rules every resolved path is held to. */
interface Rules {
  readonly home: string;
  readonly coveredRoots: readonly string[];
  readonly deniedRoots: readonly string[];
}

const isRefused = (path: string, rules: Rules): boolean =>
  isHomeOrAncestor(path, rules.home) || isWithinAny(path, rules.deniedRoots);

/** A `PATH` entry the sandbox may see, and the real dir behind it. */
interface AcceptedEntry {
  readonly entry: string;
  readonly real: string;
}

/** Accepts a `PATH` entry that exists and isn't refused, by itself or by its real dir. */
const acceptEntry = (
  fs: FileSystem.FileSystem,
  entry: string,
  rules: Rules,
): Effect.Effect<Option.Option<AcceptedEntry>> =>
  isRefused(entry, rules)
    ? Effect.succeed(Option.none())
    : realPathOf(fs, entry).pipe(
        Effect.map(Option.filter((real) => !isRefused(real, rules))),
        Effect.map(Option.map((real) => ({ entry, real }))),
      );

/** The install roots of the executables symlinked from `dir` to outside it. */
const installRootsIn = (
  fs: FileSystem.FileSystem,
  dir: string,
  rules: Rules,
): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const targets = (yield* symlinkTargetsIn(fs, dir)).filter(
      (target) =>
        !isWithin(target, dir) && !isWithinAny(target, rules.coveredRoots),
    );
    const roots = yield* Effect.all(
      targets.map((target) => installRootOf(fs, target, rules.home)),
    );
    return yield* Effect.filter(
      roots.filter((root) => !isRefused(root, rules)),
      (root) => Effect.map(isRepoRoot(fs, root), (isRepo) => !isRepo),
    );
  });

/** Keeps only the dirs not inside another dir of the list. */
const outermost = (dirs: readonly string[]): string[] => {
  const unique = [...new Set(dirs)];
  return unique.filter(
    (dir) => !unique.some((other) => other !== dir && isWithin(dir, other)),
  );
};

/** Resolves the toolchain a sandbox needs from the host `PATH`. */
export const resolveHostPathToolchain = (
  input: HostPathToolchainInput,
): Effect.Effect<HostPathToolchain, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rules: Rules = { ...input, home: normalizeEntry(input.home) };
    const entries = [
      ...new Set(
        input.path
          .split(":")
          .filter((entry) => entry.startsWith("/"))
          .map((entry) => normalizeEntry(entry)),
      ),
    ];
    const accepted = (yield* Effect.all(
      entries.map((entry) => acceptEntry(fs, entry, rules)),
    )).flatMap((a) => (Option.isSome(a) ? [a.value] : []));
    const uncovered = accepted.filter(
      (a) => !isWithinAny(a.real, rules.coveredRoots),
    );
    const installRoots = yield* Effect.all(
      [...new Set(accepted.map((a) => a.real))].map((dir) =>
        installRootsIn(fs, dir, rules),
      ),
    );
    return {
      pathEntries: accepted.map((a) => a.entry),
      readableDirs: outermost([
        ...uncovered.map((a) => a.real),
        ...installRoots.flat(),
      ]),
      symlinks: uncovered
        .filter(
          (a) =>
            a.real !== a.entry && !isWithinAny(a.entry, rules.coveredRoots),
        )
        .map((a) => ({ path: a.entry, target: a.real })),
    };
  });

/**
 * {@link resolveHostPathToolchain} for this process: the host `PATH` and home
 * dir come from the environment.
 */
export const hostPathToolchainFromEnv = (roots: {
  readonly coveredRoots: readonly string[];
  readonly deniedRoots: readonly string[];
}): Effect.Effect<HostPathToolchain, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = yield* Config.string("PATH").pipe(Config.withDefault(""));
    return yield* resolveHostPathToolchain({ path, home: homedir(), ...roots });
  }).pipe(Effect.orDie);
