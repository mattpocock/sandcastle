import { ExecFailedError } from "./ExecFailedError.js";
import type { ExecOptions, ExecResult, Sandbox } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import type { OutputDefinition } from "../Output.js";
import type {
  OutputType,
  SessionOptions,
  SessionProcess,
  SessionResult,
} from "./Session.js";
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

const execOn = (sandbox: ProviderSandbox): Sandbox["exec"] => {
  function run(
    input: string | (ExecOptions & { readonly allowFailure?: false }),
  ): Promise<ExecResult<0>>;
  function run(
    options: ExecOptions & { readonly allowFailure: true },
  ): Promise<ExecResult>;
  function run(input: string | ExecOptions): Promise<ExecResult> {
    return exec(sandbox, input);
  }
  return run;
};

type Sessions = ReturnType<typeof sessionHost>;

// The overloads type a session's output from its definition; underneath, the
// host handles any definition and the schema validates the value.
const sessionOn = (sessions: Sessions): Sandbox["session"] => {
  function run<const O extends OutputDefinition | undefined = undefined>(
    options: SessionOptions<O>,
  ): Promise<SessionResult<OutputType<O>>>;
  function run(options: SessionOptions): Promise<SessionResult> {
    return sessions.session(options);
  }
  return run;
};

const spawnSessionOn = (sessions: Sessions): Sandbox["spawnSession"] => {
  function run<const O extends OutputDefinition | undefined = undefined>(
    options: SessionOptions<O>,
  ): Promise<SessionProcess<OutputType<O>>>;
  function run(options: SessionOptions): Promise<SessionProcess> {
    return sessions.spawnSession(options);
  }
  return run;
};

/** Wraps a provider's sandbox in the handle users hold. */
export const sandboxHandle = <Native>(
  sandbox: ProviderSandbox<Native>,
  canDetach: boolean,
  supervisor: SupervisorLink,
): Sandbox<Native> => {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= supervisor.shutdown().then(async () => sandbox.close());
    return closing;
  };
  const sessions = sessionHost(supervisor, sandbox.workingDirectory);
  const handle: Sandbox<Native> = {
    sandboxId: sandbox.sandboxId,
    workingDirectory: sandbox.workingDirectory,
    killTime: sandbox.killTime,
    native: sandbox.native,
    canDetach,
    exec: execOn(sandbox),
    readTextFile: (options) => sandbox.readTextFile({ path: options.path }),
    writeTextFile: (options) =>
      sandbox.writeTextFile({ path: options.path, content: options.content }),
    session: sessionOn(sessions),
    spawnSession: spawnSessionOn(sessions),
    close,
    [Symbol.asyncDispose]: close,
  };
  return handle;
};
