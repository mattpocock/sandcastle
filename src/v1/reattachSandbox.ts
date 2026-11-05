import { DateTime } from "effect";
import type {
  DetachableSandbox,
  ReattachSandboxOptions,
  Sandbox,
} from "./Sandbox.js";
import { sandboxHandle } from "./sandboxHandle.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import { providerInternals } from "./SandboxProvider.js";
import { SandboxUnavailableError } from "./SandboxUnavailableError.js";
import { readSupervisorStatus } from "./sandboxStatus.js";
import { exitedLink, linkTo, supervisorDirectory } from "./supervisorHost.js";

/** The provider's sandbox, its commands getting `env` under their own. */
const withEnv = (
  sandbox: ProviderSandbox,
  env: Readonly<Record<string, string>> | undefined,
): ProviderSandbox =>
  env === undefined
    ? sandbox
    : {
        ...sandbox,
        exec: async (options) =>
          sandbox.exec({ ...options, env: { ...env, ...options.env } }),
      };

/**
 * Get a handle to a sandbox by its id, typically one you detached from: from
 * `DetachReceipt.sandboxId` or `sandbox.sandboxId`. The provider fetches it
 * (`daytona()` ignores its `create` options here). Detached work keeps
 * running: look at it with `status()`.
 *
 * Resolves `undefined` when the sandbox is there but its session supervisor
 * isn't (its files are gone, or Sandcastle never started one in it). Rejects
 * with `SandboxUnavailableError` when the sandbox itself is gone. A supervisor
 * that has exited after reporting its detached work still gives a handle, so
 * `status()` can read a finish report that was never delivered; its sessions
 * then reject.
 *
 * It's a full handle: `exec`, sessions, `detach()` again, and `close()`,
 * which ends the sandbox and kills the detached work. So don't
 * `await using` a handle you only want to look through.
 */
export async function reattachSandbox<Native>(
  options: ReattachSandboxOptions<Native>,
): Promise<DetachableSandbox<Native> | undefined>;
export async function reattachSandbox(
  options: ReattachSandboxOptions,
): Promise<Sandbox | undefined> {
  const { provider, sandboxId } = options;
  const { get } = providerInternals(provider);
  const found = get === undefined ? undefined : await get(sandboxId);
  if (found === undefined) {
    throw new SandboxUnavailableError({
      message: `Sandbox ${sandboxId} is gone from ${provider.name}: it was closed, hit its kill time, or never existed.`,
      sandboxId,
    });
  }
  const sandbox = withEnv(found, options.env);
  const directory = await supervisorDirectory(sandbox);
  const status = await readSupervisorStatus(sandbox, directory);
  if (status === undefined) {
    return undefined;
  }
  const supervisor =
    status.supervisor === "exited"
      ? exitedLink(directory)
      : await linkTo(sandbox, directory).catch(() => exitedLink(directory));
  return sandboxHandle({
    sandbox,
    canDetach: true,
    supervisor,
    // What's left of it: the default deadline's margin scales with it.
    timeLimitMinutes: Math.max(
      0,
      (sandbox.killTime.getTime() - DateTime.unsafeNow().epochMillis) / 60_000,
    ),
    env: { ...options.env },
  });
}
