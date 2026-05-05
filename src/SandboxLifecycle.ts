import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Deferred, Effect } from "effect";
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
import {
  Sandbox,
  type ExecResult,
  type SandboxService,
} from "./SandboxFactory.js";
import type { VersionControlProvider } from "./VersionControl.js";
import { git } from "./vcs/git.js";

const GIT_SETUP_TIMEOUT_MS = 10_000;
const HOOK_TIMEOUT_MS = 60_000;
const COMMIT_COLLECTION_TIMEOUT_MS = 30_000;
const MERGE_TO_HOST_TIMEOUT_MS = 30_000;

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
            message: `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          }),
        )
      : Effect.succeed(result),
  );

const execOkWithGitTimeout = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, ExecError | GitSetupTimeoutError> =>
  execOk(sandbox, command, options).pipe(
    withTimeout(
      GIT_SETUP_TIMEOUT_MS,
      () =>
        new GitSetupTimeoutError({
          message: `Git command timed out after ${GIT_SETUP_TIMEOUT_MS}ms: ${command}`,
          timeoutMs: GIT_SETUP_TIMEOUT_MS,
          command,
        }),
    ),
  );

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
  /** VCS provider — defaults to git(). */
  readonly vcs?: VersionControlProvider;
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
  work: (
    ctx: SandboxContext,
  ) => Effect.Effect<A, SandboxError, Sandbox | Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Sandbox | Display> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, hooks, branch, hostWorktreePath } =
      options;
    const vcs = options.vcs ?? git();

    // Resolve signal: use caller's signal or a never-aborted one so hooks
    // can unconditionally reference it without null-checking.
    const signal = options.signal ?? new AbortController().signal;

    // Without an explicit branch, record host's current branch for cherry-pick
    const hostCurrentBranch: string | null = !branch
      ? yield* Effect.promise(() => vcs.currentBranch(hostRepoDir))
      : null;

    // Read host git identity before entering the sandbox
    const { name: hostGitName, email: hostGitEmail } = yield* Effect.promise(
      () => vcs.readUserIdentity(hostRepoDir),
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
        );

        // Propagate host git identity into the sandbox so commits are attributed
        // to the actual developer without requiring manual setup.
        const identityCmds = vcs.writeUserIdentityCommands({
          name: hostGitName,
          email: hostGitEmail,
        });
        for (const cmd of identityCmds) {
          yield* execOkWithGitTimeout(sandbox, cmd);
        }

        // Repo is bind-mounted — discover branch directly
        resolvedBranch = (yield* execOkWithGitTimeout(
          sandbox,
          "git rev-parse --abbrev-ref HEAD",
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
    const baseHead = yield* Effect.promise(() =>
      vcs.headRef(hostSideWorktreePath),
    );

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    // Sync changes from sandbox to host worktree (isolated sandbox only)
    if (options.applyToHost) {
      const countResult = yield* sandbox.exec(
        `git rev-list "${baseHead}..HEAD" --count`,
        { cwd: sandboxRepoDir },
      );
      const commitCount =
        countResult.exitCode === 0
          ? parseInt(countResult.stdout.trim(), 10)
          : 0;

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
      const hasNewCommits = yield* Effect.promise(() =>
        vcs
          .commitsBetween(hostSideWorktreePath, baseHead, "HEAD")
          .then((cs) => cs.length > 0)
          .catch(() => false),
      );

      // Detach the worktree from the temp branch so the branch can be deleted.
      // This runs inside the sandbox; the agent's environment is always git
      // even when host vcs is jj.
      yield* execOk(sandbox, "git checkout --detach", { cwd: sandboxRepoDir });

      if (hasNewCommits) {
        // Fast-forward host's current branch to the temp branch
        yield* display.taskLog(`Merging to ${hostCurrentBranch}`, () =>
          Effect.tryPromise({
            try: async () => {
              try {
                await vcs.mergeBranchInto({
                  repoDir: hostRepoDir,
                  sourceBranch: resolvedBranch,
                  targetBranch: hostCurrentBranch,
                });
              } catch {
                throw new Error(
                  `Merge of '${resolvedBranch}' onto '${hostCurrentBranch}' failed. ` +
                    `The temporary branch '${resolvedBranch}' has been preserved. ` +
                    vcs.mergeFailureHint({
                      sourceBranch: resolvedBranch,
                      targetBranch: hostCurrentBranch ?? "",
                    }),
                );
              }
            },
            catch: (e) =>
              new SyncError({
                message: String(e instanceof Error ? e.message : e),
              }),
          }).pipe(
            withTimeout(
              MERGE_TO_HOST_TIMEOUT_MS,
              () =>
                new MergeToHostTimeoutError({
                  message: `Merge of '${resolvedBranch}' to '${hostCurrentBranch}' timed out after ${MERGE_TO_HOST_TIMEOUT_MS}ms`,
                  timeoutMs: MERGE_TO_HOST_TIMEOUT_MS,
                  sourceBranch: resolvedBranch,
                  targetBranch: hostCurrentBranch,
                }),
            ),
          ),
        );
      }

      // Delete the temp branch (now merged into host branch)
      yield* Effect.promise(() =>
        vcs.deleteBranch(hostRepoDir, resolvedBranch).catch(() => {}),
      );

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
            COMMIT_COLLECTION_TIMEOUT_MS,
            () =>
              new CommitCollectionTimeoutError({
                message: `Commit collection timed out after ${COMMIT_COLLECTION_TIMEOUT_MS}ms`,
                timeoutMs: COMMIT_COLLECTION_TIMEOUT_MS,
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
            COMMIT_COLLECTION_TIMEOUT_MS,
            () =>
              new CommitCollectionTimeoutError({
                message: `Commit collection timed out after ${COMMIT_COLLECTION_TIMEOUT_MS}ms`,
                timeoutMs: COMMIT_COLLECTION_TIMEOUT_MS,
              }),
          ),
        ),
      );

      finalBranch = targetBranch;
    }

    return { result, branch: finalBranch, commits };
  });
