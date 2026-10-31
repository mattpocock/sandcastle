/**
 * Which programs a host-side git call may run, chosen without the
 * repository's say. See `hostGit.ts`.
 *
 * A bind-mount sandbox can write files in the repo it works on. A `PATH`
 * entry that is relative (resolved against git's working directory) or that
 * lies inside the repo would let it plant `git` itself, `ssh`, or a
 * `git-remote-<name>` helper that host git then runs. And a remote URL can
 * name any remote helper (`<name>::…`), so the transports are restricted to
 * the ones git ships for ordinary remotes.
 */

import type { Stats } from "node:fs";
import { access, constants, realpath, stat } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { Effect, Option } from "effect";
import type { Env } from "./hostGitConfig.js";

/**
 * Transports host git may use when the caller's environment doesn't choose:
 * local paths, `git://`, HTTP(S) and SSH. Every other transport, including
 * `ext::` and any `<name>::` remote helper, is refused.
 */
export const SAFE_PROTOCOLS = "file:git:http:https:ssh";

/** The environment's own spelling of `PATH` (`Path` on Windows). */
const pathKey = (env: Env): string =>
  Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

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

/** `p` resolved, and its real path when it has one. */
const formsOf = (p: string): Effect.Effect<string[]> =>
  attempt<string>((done) => {
    realpath(p, done);
  }).pipe(
    Effect.map((real) =>
      Option.isSome(real) ? [resolve(p), real.value] : [resolve(p)],
    ),
  );

const isWithin = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The directories host git must not run programs from: the working
 * directory, and the repository's common dir and the main worktree holding
 * it, when known.
 */
export const repoRoots = (
  cwd: string,
  commonDir: string | undefined,
): string[] => {
  if (commonDir === undefined) {
    return [cwd];
  }
  return basename(commonDir) === ".git"
    ? [cwd, commonDir, dirname(commonDir)]
    : [cwd, commonDir];
};

/**
 * `pathValue` without the entries a repository could have written to: empty
 * or relative entries (resolved against git's working directory), and
 * entries inside any of `roots`.
 */
export const trustedPath = (
  pathValue: string,
  roots: readonly string[],
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const rootForms = (yield* Effect.all(roots.map((r) => formsOf(r)))).flat();
    const kept: string[] = [];
    for (const entry of pathValue.split(delimiter)) {
      if (entry !== "" && isAbsolute(entry)) {
        const forms = yield* formsOf(entry);
        const inside = forms.some((form) =>
          rootForms.some((root) => isWithin(form, root)),
        );
        if (!inside) {
          kept.push(entry);
        }
      }
    }
    return kept.join(delimiter);
  });

const isExecutableFile = (p: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const info = yield* attempt<Stats>((done) => {
      stat(p, done);
    });
    if (Option.isNone(info) || !info.value.isFile()) {
      return false;
    }
    const executable = yield* attempt<undefined>((done) => {
      access(p, constants.X_OK, (error) => {
        done(error, undefined);
      });
    });
    return Option.isSome(executable);
  });

/**
 * The absolute path of `git` on `pathValue`. Spawning that path, rather than
 * the bare name, keeps the platform's own lookup (which on Windows tries the
 * working directory first) out of it.
 */
export const findGit = (
  pathValue: string,
  env: Env,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const extensions =
      process.platform === "win32"
        ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter((ext) => ext.length > 0)
        : [""];
    const candidates = pathValue
      .split(delimiter)
      .flatMap((dir) => extensions.map((ext) => join(dir, `git${ext}`)));
    for (const candidate of candidates) {
      if (yield* isExecutableFile(candidate)) {
        return Option.some(candidate);
      }
    }
    return Option.none();
  });

/**
 * `env` with `PATH` reduced to {@link trustedPath} and, unless the caller set
 * one, `GIT_ALLOW_PROTOCOL` limited to {@link SAFE_PROTOCOLS}.
 */
export const withTrustedPrograms = (
  env: Env,
  roots: readonly string[],
): Effect.Effect<Env> =>
  Effect.gen(function* () {
    const key = pathKey(env);
    return {
      ...env,
      [key]: yield* trustedPath(env[key] ?? "", roots),
      GIT_ALLOW_PROTOCOL: env["GIT_ALLOW_PROTOCOL"] ?? SAFE_PROTOCOLS,
    };
  });

/** The `PATH` value of `env`. */
export const pathOf = (env: Env): string => env[pathKey(env)] ?? "";
