import type { OutputDefinition } from "./Output.js";
import type { Sandbox } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import type {
  OutputType,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
import { sessionHost } from "./sessionHost.js";
import type { SupervisorLink } from "./supervisorHost.js";

// A handle's `session()` and `spawnSession()`, on the sandbox's session host.

/** Runs one awaited call on the handle, or rejects once it has detached. */
export type Guard = <R>(call: () => Promise<R>) => Promise<R>;

export type Sessions = ReturnType<typeof sessionHost>;

// The overloads type a session's output from its definition; underneath, the
// host handles any definition and the schema validates the value.
export const sessionOn = (
  sessions: Sessions,
  guard: Guard,
): Sandbox["session"] => {
  function run<const O extends OutputDefinition | undefined = undefined>(
    options: SessionOptions<O>,
  ): Promise<SessionResult<OutputType<O>>>;
  function run(options: SessionOptions): Promise<SessionResult> {
    return guard(async () => sessions.session(options));
  }
  return run;
};

export const spawnSessionOn = (
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

/** Runs the sandbox's sessions, and their records, through its supervisor. */
export const sessionsOn = (
  sandbox: ProviderSandbox,
  supervisor: SupervisorLink,
): Sessions =>
  sessionHost(supervisor, {
    workingDirectory: sandbox.workingDirectory,
    record: {
      sandboxId: sandbox.sandboxId,
      killTime: sandbox.killTime,
    },
  });
