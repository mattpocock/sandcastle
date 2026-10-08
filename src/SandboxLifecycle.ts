import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Deferred, Duration, Effect, Schedule } from "effect";
import { Display } from "./Display.js";
import {
  CommitCollectionTimeoutError,
  ExecError,
  GitSetupTimeoutError,
  HookTimeoutError,
  MergeToHostTimeoutError,
  SyncError,
  withTimeout,
  type SandboxError,
} from "./errors.js";
import { type ExecResult, type SandboxService } from "./SandboxFactory.js";
import type { Timeouts } from "./run.js";
import { countCommitsToSync } from "./syncOut.js";

const GIT_SETUP_TIMEOUT_MS = 10_000;
const HOOK_TIMEOUT_MS = 60_000;
const COMMIT_COLLECTION_TIMEOUT_MS = 30_000;
const MERGE_TO_HOST_TIMEOUT_MS = 30_000;

/** Number of times a transient git setup exec is retried after the first attempt. */
const GIT_SETUP_MAX_RETRIES = 2;
/** Delay between git setup retries — long enough to let a transient exec race clear. */
const GIT_SETUP_RETRY_DELAY_MS = 250;

/**
 * Exit codes that indicate the shell could not exec the command rather than the
 * command itself failing — symptoms of a transient race under heavy container
 * load (e.g. overlayfs not yet ready, or the process being killed). Worth a retry.
 * 126: command found but not executable / exec failed. 137: killed (128 + SIGKILL).
 */
const TRANSIENT_EXEC_EXIT_CODES = new Set([126, 137]);

const isTransientExecError = (err: ExecError | GitSetupTimeoutError): boolean =>
  err._tag === "ExecError" &&
  err.exitCode !== undefined &&
  TRANSIENT_EXEC_EXIT_CODES.has(err.exitCode);

const execOk = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string; sudo?: boolean },
): Effect.Effect<ExecResult, ExecError> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode !== 0
      ? Effect.fail(
          new ExecError({
            command,
            exitCode: result.exitCode,
            message: `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          }),
        )
      : Effect.succeed(result),
  );

const execOkWithGitTimeout = (
  sandbox: SandboxService,
  command: string,
  gitSetupTimeoutMs: number,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, ExecError | GitSetupTimeoutError> =>
  execOk(sandbox, command, options).pipe(
    withTimeout(
      gitSetupTimeoutMs,
      () =>
        new GitSetupTimeoutError({
          message: `Git command timed out after ${gitSetupTimeoutMs}ms: ${command}`,
          timeoutMs: gitSetupTimeoutMs,
          command,
        }),
    ),
    // Each attempt is bounded by its own timeout (above); retry only transient
    // exec races, so a genuine git error or a hung exec still fails fast.
    Effect.retry({
      while: isTransientExecError,
      times: GIT_SETUP_MAX_RETRIES,
      schedule: Schedule.spaced(Duration.millis(GIT_SETUP_RETRY_DELAY_MS)),
    }),
  );

/**
 * Run a git read under the git-setup timeout, without the transient-retry of
 * `execOkWithGitTimeout`. Non-zero exits (e.g. `--get-all` exits 1 when the key
 * is unset) come back as a normal `ExecResult` rather than a failure; only a
 * genuine exec failure or a timeout lands in the error channel.
 */
const execReadWithGitTimeout = (
  sandbox: SandboxService,
  command: string,
  gitSetupTimeoutMs: number,
): Effect.Effect<ExecResult, ExecError | GitSetupTimeoutError> =>
  sandbox.exec(command).pipe(
    withTimeout(
      gitSetupTimeoutMs,
      () =>
        new GitSetupTimeoutError({
          message: `Git command timed out after ${gitSetupTimeoutMs}ms: ${command}`,
          timeoutMs: gitSetupTimeoutMs,
          command,
        }),
    ),
  );

/** Empty entry list, used when the existing-entries read can't be completed. */
const NO_SAFE_DIRECTORY_ENTRIES: ExecResult = {
  stdout: "",
  stderr: "",
  exitCode: 1,
};

/**
 * Idempotently register `dir` as a git `safe.directory` in the global git
 * config: read the current entries first and only append with `--add` when
 * `dir` is absent.
 *
 * A bare `git config --global --add safe.directory` appends unconditionally on
 * every run with no dedup. The global config is long-lived — for the no-sandbox
 * provider it is the developer's real `~/.gitconfig` — so without this guard the
 * same entry piles up on each run (#846).
 *
 * `getExisting` runs the read (`--get-all`); `addEntry` runs the write. Both are
 * supplied by the caller so each call site keeps its own timeout / retry policy.
 * The read is best-effort: if it can't be completed we fall back to the original
 * unconditional add (so behavior never regresses below "ensure the entry
 * exists"); the add still surfaces real errors.
 */
export const ensureSafeDirectory = <EGet, EAdd>(
  dir: string,
  getExisting: (command: string) => Effect.Effect<ExecResult, EGet>,
  addEntry: (command: string) => Effect.Effect<ExecResult, EAdd>,
): Effect.Effect<void, EAdd> =>
  Effect.gen(function* () {
    const existing = yield* getExisting(
      "git config --global --get-all safe.directory",
    ).pipe(Effect.catchAll(() => Effect.succeed(NO_SAFE_DIRECTORY_ENTRIES)));
    // Normalize separators on both sides before comparing: git reports forward
    // slashes while a no-sandbox host path on Windows can carry backslashes, so
    // a raw comparison could miss an existing entry and re-add it (#846).
    const toPosix = (p: string) => p.trim().replace(/\\/g, "/");
    const target = toPosix(dir);
    const alreadyRegistered = existing.stdout
      .split("\n")
      .map(toPosix)
      .includes(target);
    if (alreadyRegistered) return;
    yield* addEntry(`git config --global --add safe.directory "${dir}"`);
  });

const execAsync = promisify(exec);

export type SandboxHooks = {
  readonly host?: {
    readonly onWorktreeReady?: ReadonlyArray<{
      readonly command: string;
      readonly timeoutMs?: number;
    }>;
    readonly onSandboxReady?: ReadonlyArray<{
      readonly command: string;
      readonly timeoutMs?: number;
    }>;
  };
  readonly sandbox?: {
    readonly onSandboxReady?: ReadonlyArray<{
      readonly command: string;
      readonly sudo?: boolean;
      readonly timeoutMs?: number;
    }>;
  };
};

/**
 * Runs an array of host-side hook commands sequentially.
 * Each command runs on the host with the given cwd.
 * Fails fast on non-zero exit.
 */
export const runHostHooks = (
  hooks: ReadonlyArray<{
    readonly command: string;
    readonly timeoutMs?: number;
  }>,
  cwd: string,
  signal?: AbortSignal,
): Effect.Effect<void, ExecError | HookTimeoutError> =>
  Effect.gen(function* () {
    for (const hook of hooks) {
      const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
      yield* Effect.tryPromise({
        try: () => execAsync(hook.command, { cwd, signal }),
        catch: (err) =>
          new ExecError({
            command: hook.command,
            message: `Host hook failed: ${hook.command}\n${err instanceof Error ? err.message : String(err)}`,
          }),
      }).pipe(
        withTimeout(
          timeout,
          () =>
            new HookTimeoutError({
              message: `Host hook '${hook.command}' timed out after ${timeout}ms`,
              timeoutMs: timeout,
              command: hook.command,
            }),
        ),
      );
    }
  });

export interface SandboxLifecycleOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly hooks?: SandboxHooks;
  readonly branch?: string;
  /** Host-side path to the worktree directory. Required when sandboxRepoDir
   *  is a sandbox path that doesn't exist on the host (e.g. /home/agent/workspace). */
  readonly hostWorktreePath?: string;
  /** Called after agent work completes but before host-side git operations (merge, commit collection).
   *  For isolated providers, this syncs changes from the sandbox to the host worktree.
   *  For bind-mount providers, this is a no-op (filesystem is already shared). */
  readonly applyToHost?: () => Effect.Effect<void, SyncError>;
  /** AbortSignal passed through to lifecycle hooks so they can cooperatively cancel.
   *  When omitted, hooks receive a never-aborted signal. */
  readonly signal?: AbortSignal;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** When true (used by `createWorktree`'s merge-to-head path), skip the post-merge
   *  detach-and-delete of the source branch so the worktree handle stays usable for
   *  subsequent `wt.run()` / `wt.interactive()` calls. */
  readonly keepSourceBranch?: boolean;
}

export interface SandboxContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly baseHead: string;
}

export interface SandboxLifecycleResult<A> {
  readonly result: A;
  readonly branch: string;
  readonly commits: { sha: string }[];
}

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  sandbox: SandboxService,
  work: (ctx: SandboxContext) => Effect.Effect<A, SandboxError, Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Display> =>
  Effect.gen(function* () {
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, hooks, branch, hostWorktreePath } =
      options;

    // Resolve effective timeouts, falling back to the built-in defaults.
    const gitSetupTimeoutMs =
      options.timeouts?.gitSetupMs ?? GIT_SETUP_TIMEOUT_MS;
    const commitCollectionTimeoutMs =
      options.timeouts?.commitCollectionMs ?? COMMIT_COLLECTION_TIMEOUT_MS;
    const mergeToHostTimeoutMs =
      options.timeouts?.mergeToHostMs ?? MERGE_TO_HOST_TIMEOUT_MS;

    // Resolve signal: use caller's signal or a never-aborted one so hooks
    // can unconditionally reference it without null-checking.
    const signal = options.signal ?? new AbortController().signal;

    // Without an explicit branch, record host's current branch for cherry-pick
    const hostCurrentBranch: string | null = !branch
      ? yield* Effect.promise(async () => {
          const { stdout } = await execAsync(
            "git rev-parse --abbrev-ref HEAD",
            { cwd: hostRepoDir },
          );
          return stdout.trim();
        })
      : null;

    // Read host git identity before entering the sandbox
    const [hostGitName, hostGitEmail] = yield* Effect.promise(async () => {
      const [nameResult, emailResult] = await Promise.all([
        execAsync("git config user.name", { cwd: hostRepoDir })
          .then((r) => r.stdout.trim())
          .catch(() => ""),
        execAsync("git config user.email", { cwd: hostRepoDir })
          .then((r) => r.stdout.trim())
          .catch(() => ""),
      ]);
      return [nameResult, emailResult] as const;
    });

    // For host-side operations, use hostWorktreePath (the real path on the host)
    // instead of sandboxRepoDir (which may be a sandbox path like /home/agent/workspace).
    const hostSideWorktreePath = hostWorktreePath ?? sandboxRepoDir;

    // Setup: onSandboxReady hooks
    let resolvedBranch = "";
    yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        // The bind-mounted worktree may be owned by a different UID (host user
        // vs sandbox user). Mark it safe so git doesn't reject it with
        // "dubious ownership". Idempotent so repeated runs don't pile up
        // duplicate entries in a persistent global config (#846).
        yield* ensureSafeDirectory(
          sandboxRepoDir,
          (command) =>
            execReadWithGitTimeout(sandbox, command, gitSetupTimeoutMs),
          (command) =>
            execOkWithGitTimeout(sandbox, command, gitSetupTimeoutMs),
        );

        // Propagate host git identity into the sandbox so commits are attributed
        // to the actual developer without requiring manual setup.
        if (hostGitName) {
          yield* execOkWithGitTimeout(
            sandbox,
            `git config --global user.name "${hostGitName.replace(/"/g, '\\"')}"`,
            gitSetupTimeoutMs,
          );
        }
        if (hostGitEmail) {
          yield* execOkWithGitTimeout(
            sandbox,
            `git config --global user.email "${hostGitEmail.replace(/"/g, '\\"')}"`,
            gitSetupTimeoutMs,
          );
        }

        // Repo is bind-mounted — discover branch directly
        resolvedBranch = (yield* execOkWithGitTimeout(
          sandbox,
          "git rev-parse --abbrev-ref HEAD",
          gitSetupTimeoutMs,
          { cwd: sandboxRepoDir },
        )).stdout.trim();

        // Run sandbox.onSandboxReady and host.onSandboxReady in parallel
        const sandboxHooks = hooks?.sandbox?.onSandboxReady;
        const hostOnSandboxReady = hooks?.host?.onSandboxReady;

        if (sandboxHooks?.length) {
          for (const hook of sandboxHooks) {
            message(hook.command);
          }
        }
        if (hostOnSandboxReady?.length) {
          for (const hook of hostOnSandboxReady) {
            message(`[host] ${hook.command}`);
          }
        }

        // Set up abort racing for sandbox hooks (sandbox.exec doesn't
        // natively support AbortSignal, so we race via Deferred).
        const abortDeferred = yield* Deferred.make<never, ExecError>();
        let abortCleanup: (() => void) | null = null;
        if (signal.aborted) {
          yield* Deferred.fail(
            abortDeferred,
            new ExecError({
              command: "abort",
              message: `Aborted: ${signal.reason}`,
            }),
          );
        } else {
          const onAbort = () => {
            Effect.runPromise(
              Deferred.fail(
                abortDeferred,
                new ExecError({
                  command: "abort",
                  message: `Aborted: ${signal.reason}`,
                }),
              ),
            ).catch(() => {});
          };
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => signal.removeEventListener("abort", onAbort);
        }

        const sandboxHookEffects = (sandboxHooks ?? []).map((hook) => {
          const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
          return Effect.raceFirst(
            execOk(sandbox, hook.command, {
              cwd: sandboxRepoDir,
              sudo: hook.sudo,
            }).pipe(
              withTimeout(
                timeout,
                () =>
                  new HookTimeoutError({
                    message: `Hook '${hook.command}' timed out after ${timeout}ms`,
                    timeoutMs: timeout,
                    command: hook.command,
                  }),
              ),
            ),
            Deferred.await(abortDeferred) as Effect.Effect<
              never,
              ExecError,
              never
            >,
          );
        });

        const hostHookEffects = (hostOnSandboxReady ?? []).map((hook) => {
          const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
          return Effect.tryPromise({
            try: () =>
              execAsync(hook.command, {
                cwd: hostSideWorktreePath,
                signal,
              }),
            catch: (err) =>
              new ExecError({
                command: hook.command,
                message: `Host hook failed: ${hook.command}\n${err instanceof Error ? err.message : String(err)}`,
              }),
          }).pipe(
            withTimeout(
              timeout,
              () =>
                new HookTimeoutError({
                  message: `Host hook '${hook.command}' timed out after ${timeout}ms`,
                  timeoutMs: timeout,
                  command: hook.command,
                }),
            ),
          );
        });

        const allOnSandboxReady = [...sandboxHookEffects, ...hostHookEffects];
        yield* (
          allOnSandboxReady.length > 0
            ? Effect.all(allOnSandboxReady, { concurrency: "unbounded" })
            : Effect.void
        ).pipe(Effect.ensuring(Effect.sync(() => abortCleanup?.())));
      }),
    );

    const targetBranch = branch ?? resolvedBranch;

    // Record base HEAD from the host worktree (not the sandbox).
    // For bind-mount providers, these are the same. For isolated providers,
    // the host-side SHA is the correct baseline for git rev-list after applyToHost
    // syncs commits back (syncOut creates new SHAs via format-patch/am).
    const baseHead = yield* Effect.promise(async () => {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: hostSideWorktreePath,
      });
      return stdout.trim();
    });

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    // Sync changes from sandbox to host worktree (isolated sandbox only).
    // The count resolves the base from the same sandbox-owned ref `syncOut`
    // uses, so on run 2+ we don't anchor to the host's `am`-rewritten HEAD
    // (which the sandbox has never seen) and silently degrade to 0.
    if (options.applyToHost) {
      const commitCount = yield* countCommitsToSync(
        sandbox,
        sandboxRepoDir,
        baseHead,
      );

      yield* display.taskLog(
        commitCount > 0
          ? `Syncing ${commitCount} commit${commitCount !== 1 ? "s" : ""} to host`
          : "No commits to sync out",
        () => options.applyToHost!(),
      );
    }

    // Collect commits and handle cherry-pick for temp branches
    let commits: { sha: string }[];
    let finalBranch: string;

    if (hostCurrentBranch !== null) {
      // Temp branch mode: merge temp branch into host branch, then delete temp branch.
      // We use merge instead of cherry-pick because cherry-pick breaks when the
      // temp branch contains merge commits (e.g. a merge agent merging multiple parallel
      // branches). A regular merge handles both the fast-forward case (host branch hasn't
      // moved) and the diverged case (host branch has new commits since the worktree started).

      // Check if there are any new commits on the temp branch
      const hasNewCommits = yield* Effect.promise(async () => {
        try {
          const { stdout } = await execAsync(
            `git rev-list "${baseHead}..HEAD" --count`,
            { cwd: hostSideWorktreePath },
          );
          return parseInt(stdout.trim(), 10) > 0;
        } catch {
          return false;
        }
      });

      // Detach the worktree from the temp branch so the branch can be deleted.
      // Skipped when `keepSourceBranch` is set (createWorktree's merge-to-head
      // path) so the worktree stays on its source branch for re-use.
      if (!options.keepSourceBranch) {
        yield* execOk(sandbox, "git checkout --detach", {
          cwd: sandboxRepoDir,
        });
      }

      if (hasNewCommits) {
        // Fast-forward host's current branch to the temp branch
        yield* display.taskLog(`Merging to ${hostCurrentBranch}`, () =>
          Effect.tryPromise({
            try: async () => {
              try {
                await execAsync(`git merge "${resolvedBranch}"`, {
                  cwd: hostRepoDir,
                });
              } catch {
                throw new Error(
                  `Merge of '${resolvedBranch}' onto '${hostCurrentBranch}' failed. ` +
                    `The temporary branch '${resolvedBranch}' has been preserved. ` +
                    `To retry: git merge ${resolvedBranch}, ` +
                    `then clean up: git branch -D ${resolvedBranch}`,
                );
              }
            },
            catch: (e) =>
              new SyncError({
                message: String(e instanceof Error ? e.message : e),
              }),
          }).pipe(
            withTimeout(
              mergeToHostTimeoutMs,
              () =>
                new MergeToHostTimeoutError({
                  message: `Merge of '${resolvedBranch}' to '${hostCurrentBranch}' timed out after ${mergeToHostTimeoutMs}ms`,
                  timeoutMs: mergeToHostTimeoutMs,
                  sourceBranch: resolvedBranch,
                  targetBranch: hostCurrentBranch,
                }),
            ),
          ),
        );
      }

      // Delete the temp branch (now merged into host branch). Skipped when
      // `keepSourceBranch` is set: the source branch is the worktree's active
      // branch and the worktree's lifetime outlives the lifecycle.
      if (!options.keepSourceBranch) {
        yield* Effect.promise(() =>
          execAsync(`git branch -D "${resolvedBranch}"`, {
            cwd: hostRepoDir,
          }).catch(() => {}),
        );
      }

      // Collect the commits now on the host branch
      commits = yield* display.taskLog("Collecting commits", () =>
        Effect.promise(async () => {
          try {
            const { stdout } = await execAsync(
              `git rev-list "${baseHead}..HEAD" --reverse`,
              { cwd: hostRepoDir },
            );
            const lines = stdout.trim();
            if (!lines) return [];
            return lines.split("\n").map((sha) => ({ sha }));
          } catch {
            return [];
          }
        }).pipe(
          withTimeout(
            commitCollectionTimeoutMs,
            () =>
              new CommitCollectionTimeoutError({
                message: `Commit collection timed out after ${commitCollectionTimeoutMs}ms`,
                timeoutMs: commitCollectionTimeoutMs,
              }),
          ),
        ),
      );

      finalBranch = hostCurrentBranch;
    } else {
      // Explicit branch: commits stay on that branch
      commits = yield* display.taskLog("Collecting commits", () =>
        Effect.promise(async () => {
          try {
            const { stdout } = await execAsync(
              `git rev-list "${baseHead}..refs/heads/${targetBranch}" --reverse`,
              { cwd: hostRepoDir },
            );
            const lines = stdout.trim();
            if (!lines) return [];
            return lines.split("\n").map((sha) => ({ sha }));
          } catch {
            // Branch doesn't exist on host (no commits were produced)
            return [];
          }
        }).pipe(
          withTimeout(
            commitCollectionTimeoutMs,
            () =>
              new CommitCollectionTimeoutError({
                message: `Commit collection timed out after ${commitCollectionTimeoutMs}ms`,
                timeoutMs: commitCollectionTimeoutMs,
              }),
          ),
        ),
      );

      finalBranch = targetBranch;
    }

    return { result, branch: finalBranch, commits };
  });
