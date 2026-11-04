import { CreateSandboxError } from "./CreateSandboxError.js";
import type {
  CreateSandboxOptions,
  DetachableSandbox,
  Sandbox,
} from "./Sandbox.js";
import { sandboxHandle } from "./sandboxHandle.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import { providerInternals } from "./SandboxProvider.js";

const DEFAULT_TIME_LIMIT_MINUTES = 60;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const validate = (options: CreateSandboxOptions): void => {
  const minutes = options.timeLimitMinutes ?? DEFAULT_TIME_LIMIT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new RangeError(
      `createSandbox: timeLimitMinutes must be a positive number, got ${minutes}`,
    );
  }
  for (const key of Object.keys(options.env ?? {})) {
    if (!ENV_KEY.test(key)) {
      throw new TypeError(`createSandbox: invalid env var name "${key}"`);
    }
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Why a sandbox the provider made can't be handed out, if it can't. */
const unusable = (
  made: ProviderSandbox,
  abortSignal: AbortSignal | undefined,
): string | undefined => {
  if (abortSignal?.aborted === true) {
    return "creation was aborted";
  }
  if (Number.isNaN(made.killTime.getTime())) {
    return "the provider reported an invalid kill time";
  }
  return undefined;
};

const failedCreate = (
  name: string,
  cause: unknown,
  sandboxId?: string,
): CreateSandboxError =>
  new CreateSandboxError({
    message: `Could not create a sandbox on ${name}: ${errorMessage(cause)}`,
    cause,
    ...(sandboxId === undefined ? {} : { sandboxId }),
  });

/**
 * Create a sandbox on `provider` and get a handle to it. Nothing is read from
 * your repo or a `.env` file: the sandbox starts empty, with exactly the `env`
 * you pass. Rejects with `CreateSandboxError`; whatever was created by then
 * has been closed.
 *
 * Supports `await using`: leaving the block closes the sandbox.
 */
export async function createSandbox<Native>(
  options: CreateSandboxOptions<Native, true>,
): Promise<DetachableSandbox<Native>>;
export async function createSandbox<Native>(
  options: CreateSandboxOptions<Native>,
): Promise<Sandbox<Native>>;
export async function createSandbox(
  options: CreateSandboxOptions,
): Promise<Sandbox> {
  validate(options);
  const { provider, abortSignal } = options;
  const config = providerInternals(provider);
  const made = await config
    .create({
      env: { ...options.env },
      timeLimitMinutes: options.timeLimitMinutes ?? DEFAULT_TIME_LIMIT_MINUTES,
      ...(abortSignal === undefined ? {} : { abortSignal }),
    })
    .catch((error: unknown) => {
      throw failedCreate(provider.name, error);
    });
  const problem = unusable(made, abortSignal);
  if (problem !== undefined) {
    await made.close().catch(() => undefined);
    throw failedCreate(provider.name, new Error(problem), made.sandboxId);
  }
  return sandboxHandle(made, provider.canDetach);
}
