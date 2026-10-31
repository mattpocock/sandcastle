import { Deferred, Duration, Effect, Runtime, Schedule } from "effect";
import { Display } from "./Display.js";
import {
  CommitCollectionTimeoutError,
  ExecError,
  GitSetupTimeoutError,
  HookTimeoutError,
  MergeToHostTimeoutError,
  SyncError,
  withTimeout,
} from "./errors.js";
import type { SandboxError, SyncOutPathError } from "./errors.js";
import { hostGit } from "./hostGit.js";
import { execHostShell } from "./hostShell.js";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";
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
    result.exitCode === 0
      ? Effect.succeed(result)
      : Effect.fail(
          new ExecError({
            command,
            exitCode: result.exitCode,
            message: `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          }),
        ),
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

/** The commits in `range`, oldest first; none when git fails. */
const collectCommits = (
  range: readonly string[],
  hostRepoDir: string,
): Effect.Effect<{ sha: string }[]> =>
  hostGit(["rev-list", ...range, "--reverse"], hostRepoDir).pipe(
    Effect.map((stdout) => {
      const lines = stdout.trim();
      return lines === "" ? [] : lines.split("\n").map((sha) => ({ sha }));
    }),
    Effect.orElseSucceed(() => []),
  );

/**
 * Merges `sourceBranch` into the host's checked-out `targetBranch`. On
 * failure, aborts a merge that started so the host is left as it was, and
 * fails with a message saying how to retry.
 */
const mergeToHost = (
  sourceBranch: string,
  targetBranch: string,
  hostRepoDir: string,
): Effect.Effect<void, SyncError> =>
  // `--`: the branch name comes from the sandbox.
  hostGit(["merge", "--", sourceBranch], hostRepoDir).pipe(
    Effect.asVoid,
    Effect.catchAll((e) =>
      Effect.gen(function* () {
        const gitOutput = [e.stdout, e.stderr]
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .join("\n");
        // Don't leave the host mid-merge (MERGE_HEAD set, conflict markers in
        // the working tree): if the merge started, abort it so the host is as
        // it was and the retry below starts clean.
        const mergeStarted = yield* hostGit(
          ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
          hostRepoDir,
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (mergeStarted) {
          yield* hostGit(["merge", "--abort"], hostRepoDir).pipe(Effect.ignore);
        }
        return yield* new SyncError({
          message:
            `Merge of '${sourceBranch}' onto '${targetBranch}' failed${
              mergeStarted ? " and was aborted" : ""
            }, so '${targetBranch}' is unchanged.${
              gitOutput === "" ? " " : `\ngit merge said:\n${gitOutput}\n`
            }The temporary branch '${sourceBranch}' has been preserved. ` +
            `To retry: git merge ${sourceBranch} (resolve any conflicts and commit), ` +
            `then clean up: git branch -D ${sourceBranch}`,
        });
      }),
    ),
  );

export interface SandboxHooks {
  readonly host?: {
    readonly onWorktreeReady?: readonly {
      readonly command: string;
      readonly timeoutMs?: number;
    }[];
    readonly onSandboxReady?: readonly {
      readonly command: string;
      readonly timeoutMs?: number;
    }[];
  };
  readonly sandbox?: {
    readonly onSandboxReady?: readonly {
      readonly command: string;
      readonly sudo?: boolean;
      readonly timeoutMs?: number;
    }[];
  };
}

/**
 * Runs an array of host-side hook commands sequentially.
 * Each command runs on the host with the given cwd.
 * Fails fast on non-zero exit.
 */
export const runHostHooks = (
  hooks: readonly {
    readonly command: string;
    readonly timeoutMs?: number;
  }[],
  cwd: string,
  signal?: AbortSignal,
): Effect.Effect<void, ExecError | HookTimeoutError> =>
  Effect.gen(function* () {
    for (const hook of hooks) {
      const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
      yield* Effect.tryPromise({
        try: (effectSignal) =>
          execHostShell(hook.command, {
            cwd,
            signals: [signal, effectSignal],
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
  readonly applyToHost?: () => Effect.Effect<
    void,
    SyncError | SyncOutPathError
  >;
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
    const hostCurrentBranch: string | null = branch
      ? null
      : yield* hostGit(["rev-parse", "--abbrev-ref", "HEAD"], hostRepoDir).pipe(
          Effect.map((stdout) => stdout.trim()),
          Effect.orDie,
        );

    // Read host git identity before entering the sandbox
    const readIdentity = (key: string) =>
      hostGit(["config", key], hostRepoDir).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.orElseSucceed(() => ""),
      );
    const [hostGitName, hostGitEmail] = yield* Effect.all(
      [readIdentity("user.name"), readIdentity("user.email")],
      { concurrency: "unbounded" },
    );

    // For host-side operations, use hostWorktreePath (the real path on the host)
    // instead of sandboxRepoDir (which may be a sandbox path like /home/agent/workspace).
    const hostSideWorktreePath = hostWorktreePath ?? sandboxRepoDir;

    // Setup: onSandboxReady hooks
    let resolvedBranch = "";
    yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        // The bind-mounted worktree may be owned by a different UID (host user
        // vs sandbox user). Mark it safe so git doesn't reject it with
        // "dubious ownership".
        yield* execOkWithGitTimeout(
          sandbox,
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
          gitSetupTimeoutMs,
        );

        // Propagate host git identity into the sandbox so commits are attributed
        // to the actual developer without requiring manual setup.
        if (hostGitName) {
          yield* execOkWithGitTimeout(
            sandbox,
            `git config --global user.name "${hostGitName.replaceAll('"', String.raw`\"`)}"`,
            gitSetupTimeoutMs,
          );
        }
        if (hostGitEmail) {
          yield* execOkWithGitTimeout(
            sandbox,
            `git config --global user.email "${hostGitEmail.replaceAll('"', String.raw`\"`)}"`,
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
          // The listener fires outside any fiber; fork onto the surrounding runtime.
          const runFork = Runtime.runFork(yield* Effect.runtime());
          const onAbort = () => {
            runFork(
              Deferred.fail(
                abortDeferred,
                new ExecError({
                  command: "abort",
                  message: `Aborted: ${signal.reason}`,
                }),
              ),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => {
            signal.removeEventListener("abort", onAbort);
          };
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
            Deferred.await(abortDeferred),
          );
        });

        const hostHookEffects = (hostOnSandboxReady ?? []).map((hook) => {
          const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
          return Effect.tryPromise({
            try: (effectSignal) =>
              execHostShell(hook.command, {
                cwd: hostSideWorktreePath,
                signals: [signal, effectSignal],
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
    const baseHead = yield* hostGit(
      ["rev-parse", "HEAD"],
      hostSideWorktreePath,
    ).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.orDie,
    );

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    // Sync changes from sandbox to host worktree (isolated sandbox only).
    // The count resolves the base from the same sandbox-owned ref `syncOut`
    // uses, so on run 2+ we don't anchor to the host's `am`-rewritten HEAD
    // (which the sandbox has never seen) and silently degrade to 0.
    const { applyToHost } = options;
    if (applyToHost) {
      const commitCount = yield* countCommitsToSync(
        sandbox,
        sandboxRepoDir,
        baseHead,
      );

      yield* display.taskLog(
        commitCount > 0
          ? `Syncing ${commitCount} commit${commitCount === 1 ? "" : "s"} to host`
          : "No commits to sync out",
        () => applyToHost(),
      );
    }

    // Collect commits and handle cherry-pick for temp branches
    let commits: { sha: string }[];
    let finalBranch: string;

    if (hostCurrentBranch === null) {
      // Explicit branch: commits stay on that branch
      commits = yield* display.taskLog("Collecting commits", () =>
        // A missing branch on the host means no commits were produced.
        collectCommits(
          [`${baseHead}..refs/heads/${targetBranch}`],
          hostRepoDir,
        ).pipe(
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
    } else {
      // Temp branch mode: merge temp branch into host branch, then delete temp branch.
      // We use merge instead of cherry-pick because cherry-pick breaks when the
      // temp branch contains merge commits (e.g. a merge agent merging multiple parallel
      // branches). A regular merge handles both the fast-forward case (host branch hasn't
      // moved) and the diverged case (host branch has new commits since the worktree started).

      // Check if there are any new commits on the temp branch
      const hasNewCommits = yield* hostGit(
        ["rev-list", `${baseHead}..HEAD`, "--count"],
        hostSideWorktreePath,
      ).pipe(
        Effect.map((stdout) => Number.parseInt(stdout.trim(), 10) > 0),
        Effect.orElseSucceed(() => false),
      );

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
          mergeToHost(resolvedBranch, hostCurrentBranch, hostRepoDir).pipe(
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
        yield* hostGit(
          ["branch", "-D", "--", resolvedBranch],
          hostRepoDir,
        ).pipe(Effect.ignore);
      }

      // Collect the commits now on the host branch
      commits = yield* display.taskLog("Collecting commits", () =>
        collectCommits([`${baseHead}..HEAD`], hostRepoDir).pipe(
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
    }

    return { result, branch: finalBranch, commits };
  });
