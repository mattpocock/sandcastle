/**
 * Getting a sandbox ready for an agent: git setup inside the sandbox, then
 * the `onSandboxReady` hooks, sandbox-side and host-side in parallel.
 */
import { Deferred, Duration, Effect, Runtime, Schedule } from "effect";
import {
  ExecError,
  GitSetupTimeoutError,
  HookTimeoutError,
  withTimeout,
} from "./errors.js";
import { execHostShell } from "./hostShell.js";
import type { ExecResult, SandboxService } from "./SandboxFactory.js";

export const HOOK_TIMEOUT_MS = 60_000;

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

/** A hook command run on the host. */
export interface HostHook {
  readonly command: string;
  readonly timeoutMs?: number;
}

/** A hook command run inside the sandbox. */
export interface SandboxHook extends HostHook {
  readonly sudo?: boolean;
}

/** Runs `command` in the sandbox, failing on a non-zero exit. */
export const execOk = (
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

/** Where git setup commands run, and how long each may take. */
interface GitSetupTarget {
  readonly sandbox: SandboxService;
  readonly timeoutMs: number;
}

const execOkWithGitTimeout = (
  target: GitSetupTarget,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, ExecError | GitSetupTimeoutError> =>
  execOk(target.sandbox, command, options).pipe(
    withTimeout(
      target.timeoutMs,
      () =>
        new GitSetupTimeoutError({
          message: `Git command timed out after ${target.timeoutMs}ms: ${command}`,
          timeoutMs: target.timeoutMs,
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

const escapeDoubleQuotes = (value: string): string =>
  value.replaceAll('"', String.raw`\"`);

export interface SandboxGitSetup {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly gitSetupTimeoutMs: number;
  /** The host's git identity; an empty field is not copied. */
  readonly identity: { readonly name: string; readonly email: string };
}

/**
 * Prepares git inside the sandbox and returns the branch its repo is on.
 */
export const setUpSandboxGit = (
  setup: SandboxGitSetup,
): Effect.Effect<string, ExecError | GitSetupTimeoutError> =>
  Effect.gen(function* () {
    const target = {
      sandbox: setup.sandbox,
      timeoutMs: setup.gitSetupTimeoutMs,
    };
    const { name, email } = setup.identity;
    // The bind-mounted worktree may be owned by a different UID (host user
    // vs sandbox user). Mark it safe so git doesn't reject it with
    // "dubious ownership".
    yield* execOkWithGitTimeout(
      target,
      `git config --global --add safe.directory "${setup.sandboxRepoDir}"`,
    );

    // Propagate host git identity into the sandbox so commits are attributed
    // to the actual developer without requiring manual setup.
    if (name) {
      yield* execOkWithGitTimeout(
        target,
        `git config --global user.name "${escapeDoubleQuotes(name)}"`,
      );
    }
    if (email) {
      yield* execOkWithGitTimeout(
        target,
        `git config --global user.email "${escapeDoubleQuotes(email)}"`,
      );
    }

    // Repo is bind-mounted — discover branch directly
    const head = yield* execOkWithGitTimeout(
      target,
      "git rev-parse --abbrev-ref HEAD",
      { cwd: setup.sandboxRepoDir },
    );
    return head.stdout.trim();
  });

/** Runs one host hook in `cwd`, failing on a non-zero exit or its timeout. */
export const runHostHook = (
  hook: HostHook,
  cwd: string,
  signal?: AbortSignal,
): Effect.Effect<void, ExecError | HookTimeoutError> => {
  const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
  return Effect.tryPromise({
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
};

const abortError = (signal: AbortSignal): ExecError =>
  new ExecError({
    command: "abort",
    message: `Aborted: ${signal.reason}`,
  });

/** A Deferred that fails once `signal` aborts, and how to stop listening. */
interface AbortRace {
  readonly aborted: Deferred.Deferred<never, ExecError>;
  readonly cleanup?: () => void;
}

/**
 * Sets up abort racing for sandbox hooks (sandbox.exec doesn't natively
 * support AbortSignal, so we race via Deferred).
 */
const raceAbort = (signal: AbortSignal): Effect.Effect<AbortRace> =>
  Effect.gen(function* () {
    const aborted = yield* Deferred.make<never, ExecError>();
    if (signal.aborted) {
      yield* Deferred.fail(aborted, abortError(signal));
      return { aborted };
    }
    // The listener fires outside any fiber; fork onto the surrounding runtime.
    const runFork = Runtime.runFork(yield* Effect.runtime());
    const onAbort = () => {
      runFork(Deferred.fail(aborted, abortError(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return {
      aborted,
      cleanup: () => {
        signal.removeEventListener("abort", onAbort);
      },
    };
  });

/** Where a sandbox hook runs, and the abort it races. */
interface SandboxHookTarget {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly aborted: Deferred.Deferred<never, ExecError>;
}

const runSandboxHook = (
  hook: SandboxHook,
  target: SandboxHookTarget,
): Effect.Effect<ExecResult, ExecError | HookTimeoutError> => {
  const timeout = hook.timeoutMs ?? HOOK_TIMEOUT_MS;
  return Effect.raceFirst(
    execOk(target.sandbox, hook.command, {
      cwd: target.sandboxRepoDir,
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
    Deferred.await(target.aborted),
  );
};

export interface OnSandboxReadyHooks {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  /** The worktree's real path on the host, where host hooks run. */
  readonly hostWorktreePath: string;
  readonly signal: AbortSignal;
  readonly sandboxHooks: readonly SandboxHook[];
  readonly hostHooks: readonly HostHook[];
}

/**
 * Runs sandbox.onSandboxReady and host.onSandboxReady in parallel. Sandbox
 * hooks stop when `signal` aborts.
 */
export const runOnSandboxReadyHooks = (
  hooks: OnSandboxReadyHooks,
): Effect.Effect<void, ExecError | HookTimeoutError> =>
  Effect.gen(function* () {
    const { aborted, cleanup } = yield* raceAbort(hooks.signal);
    const target = {
      sandbox: hooks.sandbox,
      sandboxRepoDir: hooks.sandboxRepoDir,
      aborted,
    };
    const all = [
      ...hooks.sandboxHooks.map((hook) => runSandboxHook(hook, target)),
      ...hooks.hostHooks.map((hook) =>
        runHostHook(hook, hooks.hostWorktreePath, hooks.signal),
      ),
    ];
    // Typed so the ternary's union doesn't widen to unknown through .pipe.
    const runAll: Effect.Effect<unknown, ExecError | HookTimeoutError> =
      all.length > 0
        ? Effect.all(all, { concurrency: "unbounded" })
        : Effect.void;
    yield* runAll.pipe(Effect.ensuring(Effect.sync(() => cleanup?.())));
  });
