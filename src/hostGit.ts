/**
 * The single choke point for running `git` on the host.
 *
 * Bind-mount sandbox providers share the host repo's `.git` with the sandbox,
 * so a sandboxed agent can write repository config, hooks and the worktree's
 * `.git` pointer. Several config keys name a program for git to run, so an
 * unguarded host-side `git status` would run whatever the agent put there,
 * outside the sandbox. Every host-side git call in `src/` goes through
 * `hostGit()` (`hostGit.guard.test.ts` fails otherwise), which:
 *
 * 1. Checks the working directory's `.git` before running anything: a linked
 *    worktree's `.git` file must lead to `<common dir>/worktrees/<name>`, its
 *    `commondir` back to that common dir, and a worktree under
 *    `.sandcastle/worktrees/` must belong to the repo it sits in. The
 *    validated paths are then pinned with `GIT_DIR`, `GIT_COMMON_DIR` and
 *    `GIT_WORK_TREE`, so git never re-reads the pointer files.
 * 2. Overrides the config keys that run a program, through `GIT_CONFIG_*`
 *    environment variables, which beat every config file. The value kept is
 *    the one from system or global config (or the caller's own environment),
 *    never the repository's; without one, a value that runs nothing.
 * 3. Chooses which programs git may run without the repository's say:
 *    `PATH` loses relative entries and entries inside the repo (so a planted
 *    `git`, `ssh` or remote helper is never found), `git` itself is spawned
 *    by absolute path, and `GIT_ALLOW_PROTOCOL` limits transports to
 *    `file:git:http:https:ssh` unless the caller's environment sets it.
 * 4. Spawns `git` with an argv (no shell) in the C locale, with terminal
 *    prompts off.
 */

import { execFile } from "node:child_process";
import { Effect, Option } from "effect";
import { HostGitError } from "./errors.js";
import type { Env } from "./hostGitConfig.js";
import {
  hardeningOverrides,
  parseConfigList,
  withConfigOverrides,
} from "./hostGitConfig.js";
import { resolveGitDirPins } from "./hostGitDir.js";
import {
  findGit,
  pathOf,
  repoRoots,
  withTrustedPrograms,
} from "./hostGitPath.js";

/** Options for {@link hostGit}. */
export interface HostGitOptions {
  /** Extra environment variables for git, on top of `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to git's stdin, which is otherwise closed straight away. */
  readonly input?: string;
}

/** What a successful host git call printed. */
export interface HostGitOutput {
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_BUFFER = 10 * 1024 * 1024;

interface SpawnOptions {
  readonly git: string;
  readonly cwd: string;
  readonly env: Env;
  readonly input?: string;
}

const ignoreStdinError = (): undefined => undefined;

/** Runs git with exactly `env`. */
const spawnGit = (
  args: readonly string[],
  { git, cwd, env, input = "" }: SpawnOptions,
): Effect.Effect<HostGitOutput, HostGitError> =>
  Effect.async((resume) => {
    const child = execFile(
      git,
      [...args],
      { cwd, env, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new HostGitError({
                message: stderr.trim() || error.message,
                args,
                stdout,
                stderr,
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed({ stdout, stderr }));
      },
    );
    // Not killed on interruption: a git command stopped half-way (a merge,
    // `git am`) could leave the host repo locked or half-updated.
    // Git may exit without reading stdin; the EPIPE that follows is harmless,
    // but unhandled it would crash the process.
    child.stdin?.on("error", ignoreStdinError);
    child.stdin?.end(input);
  });

/**
 * Run `git <args>` on the host in `cwd`, hardened against code execution
 * through repository-controlled config, hooks and `.git` pointers (see the
 * module comment). Succeeds with stdout and stderr; fails with
 * `HostGitError` when `cwd`'s `.git` is not where it should be, or when git
 * exits non-zero.
 */
export const hostGitOutput = (
  args: readonly string[],
  cwd: string,
  options?: HostGitOptions,
): Effect.Effect<HostGitOutput, HostGitError> =>
  Effect.gen(function* () {
    const pins = yield* resolveGitDirPins(cwd, args);
    const env = yield* withTrustedPrograms(
      {
        ...process.env,
        ...options?.env,
        ...pins,
        // Several callers match git's messages; under a localized locale they
        // would silently stop matching (issue #595).
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
      },
      repoRoots(cwd, pins["GIT_COMMON_DIR"]),
    );
    const found = yield* findGit(pathOf(env), env);
    if (Option.isNone(found)) {
      return yield* new HostGitError({
        message: "git was not found on PATH (outside the repository)",
        args,
        stdout: "",
        stderr: "",
      });
    }
    const git = found.value;
    const listed = yield* spawnGit(["config", "--list", "--show-scope", "-z"], {
      git,
      cwd,
      env,
    }).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "" })));
    const overrides = hardeningOverrides(parseConfigList(listed.stdout));
    return yield* spawnGit(args, {
      git,
      cwd,
      env: withConfigOverrides(env, overrides),
      input: options?.input,
    });
  });

/** {@link hostGitOutput}, succeeding with stdout only. */
export const hostGit = (
  args: readonly string[],
  cwd: string,
  options?: HostGitOptions,
): Effect.Effect<string, HostGitError> =>
  hostGitOutput(args, cwd, options).pipe(Effect.map((o) => o.stdout));
