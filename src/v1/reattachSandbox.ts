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
import type { SpawnDetached } from "./supervisorHost.js";
import { supervisorDirectory } from "./supervisorHost.js";
import { reattachedLink } from "./supervisorRestart.js";

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
 * Starts a restarted supervisor in the provider's own sandbox (the one it
 * can detach work in), with the env passed to reattach under its own.
 */
const restartIn = (
  found: ProviderSandbox,
  spawnDetached: SpawnDetached | undefined,
  env: Readonly<Record<string, string>> | undefined,
): SpawnDetached | undefined =>
  spawnDetached === undefined
    ? undefined
    : async (_sandbox, options) =>
        spawnDetached(found, { ...options, env: { ...env, ...options.env } });

/**
 * Get a handle to a sandbox by its id, typically one you detached from: from
 * `DetachReceipt.sandboxId` or `sandbox.sandboxId`. The provider fetches it
 * (`daytona()` ignores its `create` options here). Detached work keeps
 * running: look at it with `status()`.
 *
 * Resolves `undefined` when the sandbox is there but its session supervisor
 * isn't (its files are gone, or Sandcastle never started one in it). Rejects
 * with `SandboxUnavailableError` when the sandbox itself is gone.
 *
 * It's a full handle: `exec`, sessions, `detach()` again, and `close()`,
 * which ends the sandbox and kills the detached work. So don't
 * `await using` a handle you only want to look through. While detached work
 * still runs, its new sessions reject: only work spawned before a detach
 * carries on.
 *
 * Reuse a sandbox across steps this way. Once a detach's work is reported,
 * its supervisor exits, so a sandbox waiting for its next step runs none.
 * The handle's first `session`, `spawnSession` or `detach` then starts a
 * new supervisor in the same sandbox, which keeps the earlier status and
 * finish reports. `status()` and `follow()` never start one: a handle only
 * looked through reads the reports, delivered or not, and nothing more.
 */
export async function reattachSandbox<Native>(
  options: ReattachSandboxOptions<Native>,
): Promise<DetachableSandbox<Native> | undefined>;
export async function reattachSandbox(
  options: ReattachSandboxOptions,
): Promise<Sandbox | undefined> {
  const { provider, sandboxId } = options;
  const { get, spawnDetached } = providerInternals(provider);
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
  // Linked on first use, so a handle only looked through (status(),
  // follow()) never waits on the supervisor's client; restarted then when
  // the last one has exited.
  const supervisor = reattachedLink({
    sandbox,
    directory,
    spawnDetached: restartIn(found, spawnDetached, options.env),
    exited: status.supervisor === "exited",
  });
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
