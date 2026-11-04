import { ExecFailedError } from "./ExecFailedError.js";
import type { ExecOptions, ExecResult, Sandbox } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";

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

/** Wraps a provider's sandbox in the handle users hold. */
export const sandboxHandle = <Native>(
  sandbox: ProviderSandbox<Native>,
  canDetach: boolean,
): Sandbox<Native> => {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= sandbox.close();
    return closing;
  };
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
    close,
    [Symbol.asyncDispose]: close,
  };
  return handle;
};
