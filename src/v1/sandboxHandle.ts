import { detachFrom, trackDeadline } from "./detachHost.js";
import { ExecFailedError } from "./ExecFailedError.js";
import type { SandboxDetachedError } from "./SandboxDetachedError.js";
import type {
  DetachOptions,
  ExecOptions,
  ExecResult,
  Sandbox,
  StatusOptions,
} from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import type { OutputDefinition } from "./Output.js";
import type {
  OutputType,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
import { readStatus } from "./sandboxStatus.js";
import { sessionHost } from "./sessionHost.js";
import type { SupervisorLink } from "./supervisorHost.js";

const exec = async (
  sandbox: ProviderSandbox,
  input: string | ExecOptions,
): Promise<ExecResult> => {
  const options: ExecOptions =
    typeof input === "string" ? { command: input } : input;
  const { allowFailure = false, ...providerOptions } = options;
  const result = await sandbox.exec(providerOptions);
  if (result.exitCode !== 0 && !allowFailure) {
    throw new ExecFailedError({
      message: `Command exited with code ${result.exitCode}: ${options.command}`,
      command: options.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
};

/** Runs one awaited call on the handle, or rejects once it has detached. */
type Guard = <R>(call: () => Promise<R>) => Promise<R>;

const execOn = (sandbox: ProviderSandbox, guard: Guard): Sandbox["exec"] => {
  function run(
    input: string | (ExecOptions & { readonly allowFailure?: false }),
  ): Promise<ExecResult<0>>;
  function run(
    options: ExecOptions & { readonly allowFailure: true },
  ): Promise<ExecResult>;
  function run(input: string | ExecOptions): Promise<ExecResult> {
    return guard(async () => exec(sandbox, input));
  }
  return run;
};

type Sessions = ReturnType<typeof sessionHost>;

// The overloads type a session's output from its definition; underneath, the
// host handles any definition and the schema validates the value.
const sessionOn = (sessions: Sessions, guard: Guard): Sandbox["session"] => {
  function run<const O extends OutputDefinition | undefined = undefined>(
    options: SessionOptions<O>,
  ): Promise<SessionResult<OutputType<O>>>;
  function run(options: SessionOptions): Promise<SessionResult> {
    return guard(async () => sessions.session(options));
  }
  return run;
};

const spawnSessionOn = (
  sessions: Sessions,
  guard: Guard,
): Sandbox["spawnSession"] => {
  function run<const O extends OutputDefinition | undefined = undefined>(
    options: SessionOptions<O>,
  ): Promise<SessionProcess<OutputType<O>>>;
  function run(options: SessionOptions): Promise<SessionProcess> {
    return guard(async () => sessions.spawnSession(options));
  }
  return run;
};

/**
 * Tracks the handle's awaited calls, so `detach()` can refuse while one is
 * pending, and rejects every call once the handle has detached.
 */
const callGuard = () => {
  let pending = 0;
  let detached: SandboxDetachedError | undefined;
  const guard: Guard = async (call) => {
    if (detached !== undefined) {
      throw detached;
    }
    pending += 1;
    try {
      return await call();
    } finally {
      pending -= 1;
    }
  };
  return {
    guard,
    pending: () => pending,
    detached: () => detached,
    letGo: (error: SandboxDetachedError) => {
      detached = error;
    },
  };
};

/** Where the handle's sandbox lives and how it was made. */
export interface HandleParts<Native> {
  readonly sandbox: ProviderSandbox<Native>;
  readonly canDetach: boolean;
  readonly supervisor: SupervisorLink;
  readonly timeLimitMinutes: number;
}

/** Adds `detach()` to a handle whose provider can detach. */
const withDetach = <Native>(
  handle: Sandbox<Native>,
  {
    parts,
    calls,
    sessions,
  }: {
    readonly parts: Omit<HandleParts<Native>, "canDetach">;
    readonly calls: ReturnType<typeof callGuard>;
    readonly sessions: Sessions;
  },
): Sandbox<Native> => {
  const detach = detachFrom({
    sandbox: parts.sandbox,
    link: parts.supervisor,
    timeLimitMinutes: parts.timeLimitMinutes,
    handle,
    pendingCalls: calls.pending,
    runningSessions: sessions.runningCount,
    letGo: (error) => {
      calls.letGo(error);
      sessions.letGo(error);
    },
  });
  return Object.assign(handle, {
    detach: async (options?: DetachOptions) => {
      const detached = calls.detached();
      if (detached !== undefined) {
        throw detached;
      }
      return detach(options);
    },
    // Reads files only, so it works after a detach too.
    status: async (options?: StatusOptions) =>
      readStatus(parts.sandbox, parts.supervisor.directory, options),
  });
};

/** Runs the sandbox's sessions, and their records, through its supervisor. */
const sessionsOn = (
  sandbox: ProviderSandbox,
  supervisor: SupervisorLink,
): Sessions =>
  sessionHost(supervisor, {
    workingDirectory: sandbox.workingDirectory,
    record: {
      sandboxId: sandbox.sandboxId,
      killTime: sandbox.killTime,
      publicKey: supervisor.publicKey,
    },
  });

/** Wraps a provider's sandbox in the handle users hold. */
export const sandboxHandle = <Native>({
  sandbox,
  canDetach,
  supervisor,
  timeLimitMinutes,
}: HandleParts<Native>): Sandbox<Native> => {
  const calls = callGuard();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // After a detach the work carries on: closing would end it.
    closing ??=
      calls.detached() === undefined
        ? supervisor.shutdown().then(async () => sandbox.close())
        : Promise.resolve();
    return closing;
  };
  const sessions = sessionsOn(sandbox, supervisor);
  const { guard } = calls;
  const handle: Sandbox<Native> = {
    sandboxId: sandbox.sandboxId,
    workingDirectory: sandbox.workingDirectory,
    killTime: sandbox.killTime,
    native: sandbox.native,
    canDetach,
    exec: execOn(sandbox, guard),
    readTextFile: async (options) =>
      guard(async () => sandbox.readTextFile({ path: options.path })),
    writeTextFile: async (options) =>
      guard(async () =>
        sandbox.writeTextFile({ path: options.path, content: options.content }),
      ),
    session: sessionOn(sessions, guard),
    spawnSession: spawnSessionOn(sessions, guard),
    close,
    [Symbol.asyncDispose]: close,
  };
  trackDeadline(handle, sandbox.killTime, timeLimitMinutes);
  return canDetach
    ? withDetach(handle, {
        parts: { sandbox, supervisor, timeLimitMinutes },
        calls,
        sessions,
      })
    : handle;
};
