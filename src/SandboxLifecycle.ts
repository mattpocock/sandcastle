import { Effect } from "effect";
import { Display } from "./Display.js";
import type {
  ExecError,
  HookTimeoutError,
  SandboxError,
  SyncError,
  SyncOutPathError,
} from "./errors.js";
import { hostGit } from "./hostGit.js";
import {
  collectCommitsLogged,
  mergeTempBranch,
  readHostCurrentBranch,
  readHostIdentity,
} from "./lifecycleHostGit.js";
import type { SandboxService } from "./SandboxFactory.js";
import type { Timeouts } from "./run.js";
import {
  runHostHook,
  runOnSandboxReadyHooks,
  setUpSandboxGit,
} from "./sandboxSetup.js";
import { countCommitsToSync } from "./syncOut.js";

const GIT_SETUP_TIMEOUT_MS = 10_000;
const COMMIT_COLLECTION_TIMEOUT_MS = 30_000;
const MERGE_TO_HOST_TIMEOUT_MS = 30_000;

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
      yield* runHostHook(hook, cwd, signal);
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

/** One lifecycle's resolved settings, shared by its steps. */
interface LifecycleRun {
  readonly options: SandboxLifecycleOptions;
  readonly sandbox: SandboxService;
  readonly gitSetupTimeoutMs: number;
  readonly commitCollectionTimeoutMs: number;
  readonly mergeToHostTimeoutMs: number;
  /** The caller's signal, or a never-aborted one so hooks can reference it
   *  unconditionally without null-checking. */
  readonly signal: AbortSignal;
  /** For host-side operations: hostWorktreePath (the real path on the host)
   *  instead of sandboxRepoDir (which may be a sandbox path like
   *  /home/agent/workspace). */
  readonly hostSideWorktreePath: string;
}

const resolveRun = (
  options: SandboxLifecycleOptions,
  sandbox: SandboxService,
): LifecycleRun => ({
  options,
  sandbox,
  // Resolve effective timeouts, falling back to the built-in defaults.
  gitSetupTimeoutMs: options.timeouts?.gitSetupMs ?? GIT_SETUP_TIMEOUT_MS,
  commitCollectionTimeoutMs:
    options.timeouts?.commitCollectionMs ?? COMMIT_COLLECTION_TIMEOUT_MS,
  mergeToHostTimeoutMs:
    options.timeouts?.mergeToHostMs ?? MERGE_TO_HOST_TIMEOUT_MS,
  signal: options.signal ?? new AbortController().signal,
  hostSideWorktreePath: options.hostWorktreePath ?? options.sandboxRepoDir,
});

/**
 * Sets up git in the sandbox and runs the onSandboxReady hooks. Returns the
 * branch the sandbox's repo is on.
 */
const setUpSandbox = (
  run: LifecycleRun,
  identity: { name: string; email: string },
): Effect.Effect<string, SandboxError, Display> =>
  Effect.gen(function* () {
    const display = yield* Display;
    const { sandbox, options } = run;
    const { sandboxRepoDir, hooks } = options;
    return yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        const resolvedBranch = yield* setUpSandboxGit({
          sandbox,
          sandboxRepoDir,
          gitSetupTimeoutMs: run.gitSetupTimeoutMs,
          identity,
        });

        const sandboxHooks = hooks?.sandbox?.onSandboxReady ?? [];
        const hostHooks = hooks?.host?.onSandboxReady ?? [];
        for (const hook of sandboxHooks) {
          message(hook.command);
        }
        for (const hook of hostHooks) {
          message(`[host] ${hook.command}`);
        }

        yield* runOnSandboxReadyHooks({
          sandbox,
          sandboxRepoDir,
          hostWorktreePath: run.hostSideWorktreePath,
          signal: run.signal,
          sandboxHooks,
          hostHooks,
        });
        return resolvedBranch;
      }),
    );
  });

/**
 * Syncs changes from sandbox to host worktree (isolated sandbox only).
 * The count resolves the base from the same sandbox-owned ref `syncOut`
 * uses, so on run 2+ we don't anchor to the host's `am`-rewritten HEAD
 * (which the sandbox has never seen) and silently degrade to 0.
 */
const syncToHost = (
  run: LifecycleRun,
  baseHead: string,
): Effect.Effect<void, SandboxError, Display> =>
  Effect.gen(function* () {
    const { applyToHost, sandboxRepoDir } = run.options;
    if (!applyToHost) {
      return;
    }
    const display = yield* Display;
    const commitCount = yield* countCommitsToSync(
      run.sandbox,
      sandboxRepoDir,
      baseHead,
    );

    yield* display.taskLog(
      commitCount > 0
        ? `Syncing ${commitCount} commit${commitCount === 1 ? "" : "s"} to host`
        : "No commits to sync out",
      () => applyToHost(),
    );
  });

/**
 * Temp branch mode: merges the temp branch into the host's branch and
 * returns the commits made by the agent on the temp branch.
 */
const mergeBack = (
  run: LifecycleRun,
  branches: {
    readonly baseHead: string;
    readonly tempBranch: string;
    readonly hostBranch: string;
  },
): Effect.Effect<{ sha: string }[], SandboxError, Display> =>
  Effect.gen(function* () {
    const { baseHead } = branches;
    // Collect the agent's commits from the temp branch before merging,
    // so host-branch drift (and the merge commit itself) does not bleed into the result.
    const commits = yield* collectCommitsLogged(
      `${baseHead}..HEAD`,
      run.hostSideWorktreePath,
      run.commitCollectionTimeoutMs,
    );
    yield* mergeTempBranch({
      sandbox: run.sandbox,
      sandboxRepoDir: run.options.sandboxRepoDir,
      hostRepoDir: run.options.hostRepoDir,
      keepSourceBranch: run.options.keepSourceBranch === true,
      mergeToHostTimeoutMs: run.mergeToHostTimeoutMs,
      hasNewCommits: commits.length > 0,
      tempBranch: branches.tempBranch,
      hostBranch: branches.hostBranch,
    });
    return commits;
  });

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  sandbox: SandboxService,
  work: (ctx: SandboxContext) => Effect.Effect<A, SandboxError, Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Display> =>
  Effect.gen(function* () {
    const run = resolveRun(options, sandbox);
    const { sandboxRepoDir } = options;

    const hostCurrentBranch = yield* readHostCurrentBranch(options);
    // Read host git identity before entering the sandbox
    const identity = yield* readHostIdentity(options.hostRepoDir);
    const resolvedBranch = yield* setUpSandbox(run, identity);
    const targetBranch = options.branch ?? resolvedBranch;

    // Record base HEAD from the host worktree (not the sandbox).
    // For bind-mount providers, these are the same. For isolated providers,
    // the host-side SHA is the correct baseline for git rev-list after applyToHost
    // syncs commits back (syncOut creates new SHAs via format-patch/am).
    const baseHead = yield* hostGit(
      ["rev-parse", "HEAD"],
      run.hostSideWorktreePath,
    ).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.orDie,
    );

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });
    yield* syncToHost(run, baseHead);

    if (hostCurrentBranch === null) {
      // Explicit branch: commits stay on that branch. A missing branch on
      // the host means no commits were produced.
      const commits = yield* collectCommitsLogged(
        `${baseHead}..refs/heads/${targetBranch}`,
        options.hostRepoDir,
        run.commitCollectionTimeoutMs,
      );
      return { result, branch: targetBranch, commits };
    }

    const commits = yield* mergeBack(run, {
      baseHead,
      tempBranch: resolvedBranch,
      hostBranch: hostCurrentBranch,
    });
    return { result, branch: hostCurrentBranch, commits };
  });
