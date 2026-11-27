/**
 * Repository config that git may read in a context other than the one a
 * host git call is listed in. See `hostGit.ts`.
 *
 * `git config --list` in the repo shows only the includes whose condition
 * holds there. But some commands start git again elsewhere: `git worktree
 * add` checks out the new worktree with a child git whose `gitdir:`,
 * `worktree:` and `onbranch:` conditions are evaluated for that worktree. So
 * every file the repository's config includes, under any condition, is read
 * here too, and its entries are overridden like the repository's own.
 */

import type { Stats } from "node:fs";
import { stat } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect } from "effect";
import type { Env } from "./hostGitConfig.js";
import type { GitConfigEntry } from "./hostGitEntries.js";
import { isTrusted, parseFileConfigList } from "./hostGitEntries.js";

/** The scope given to entries read from an included file. Untrusted. */
const INCLUDED_SCOPE = "included";

/** git's own limit on nested includes. */
const MAX_INCLUDE_DEPTH = 10;

const isIncludeKey = (key: string): boolean =>
  key === "include.path" ||
  (key.startsWith("includeif.") && key.endsWith(".path"));

/**
 * The file an include entry names, as git resolves it: `~/` from `HOME`,
 * relative paths from the including file's dir. `undefined` for paths that
 * leave the repository's reach (`%(prefix)/`, the git install; `~user/`)
 * and for includes not read from a file.
 */
const includeTarget = (
  entry: GitConfigEntry,
  cwd: string,
  env: Env,
): string | undefined => {
  const path = entry.value;
  if (path === undefined || path === "" || !entry.origin.startsWith("file:")) {
    return undefined;
  }
  const including = resolve(cwd, entry.origin.slice("file:".length));
  if (path.startsWith("~/")) {
    const home = env["HOME"];
    return home === undefined ? undefined : join(home, path.slice(2));
  }
  if (path.startsWith("~") || path.startsWith("%(prefix)/")) {
    return undefined;
  }
  return isAbsolute(path) ? path : resolve(dirname(including), path);
};

/** Whether `path` is a regular file (a FIFO or device is never opened). */
const isRegularFile = (path: string): Effect.Effect<boolean> =>
  Effect.async((resume) => {
    stat(path, (error: Error | null, stats: Stats | undefined) => {
      resume(Effect.succeed(error === null && stats?.isFile() === true));
    });
  });

/** Where include paths are resolved from, and how a file's config is read. */
interface IncludeContext {
  /** The host git call's working directory. */
  readonly cwd: string;
  /** Its environment (`HOME` resolves `~/`). */
  readonly env: Env;
  /** Prints `git config --file <file> --no-includes --list -z`. */
  readonly listFile: (file: string) => Effect.Effect<string>;
}

/**
 * Every entry of every file the repository's config includes, under any
 * condition and at any depth (up to git's limit), as untrusted entries.
 * Files `listFile` can't read are skipped, as git would fail on them. Only regular
 * files are read, so an included FIFO can't block the call here.
 */
export const repoIncludedEntries = (
  entries: readonly GitConfigEntry[],
  { cwd, env, listFile }: IncludeContext,
): Effect.Effect<GitConfigEntry[]> =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const found: GitConfigEntry[] = [];
    let pending = entries.filter((e) => !isTrusted(e) && isIncludeKey(e.key));
    for (
      let depth = 0;
      depth < MAX_INCLUDE_DEPTH && pending.length > 0;
      depth++
    ) {
      const next: GitConfigEntry[] = [];
      for (const include of pending) {
        const file = includeTarget(include, cwd, env);
        if (file !== undefined && !seen.has(file)) {
          seen.add(file);
          if (yield* isRegularFile(file)) {
            const read = parseFileConfigList(
              yield* listFile(file),
              file,
              INCLUDED_SCOPE,
            );
            found.push(...read);
            next.push(...read.filter((e) => isIncludeKey(e.key)));
          }
        }
      }
      pending = next;
    }
    return found;
  });
