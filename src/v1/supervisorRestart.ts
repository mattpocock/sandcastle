import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderSandbox } from "./SandboxProvider.js";
import { readSupervisorStatus } from "./sandboxStatus.js";
import type { SpawnDetached, SupervisorLink } from "./supervisorHost.js";
import { linkTo, startSupervisor } from "./supervisorHost.js";
import type { SupervisorStatus } from "./supervisorStatusSchema.js";
import { STATUS_FILE } from "./supervisorStatusSchema.js";

// A reattached handle's link to its supervisor. The supervisor exits once
// its detached work is reported, so a sandbox waiting for its next step holds
// no supervisor process. The first session, spawn or detach on a reattached
// handle then starts a new one in the same sandbox and directory, the way
// createSandbox does: the bundle, a new key pair, a hello. It keeps the
// earlier status, reports and records it finds there.

/** What a reattached handle needs to restart its sandbox's supervisor. */
export interface Restart {
  readonly sandbox: ProviderSandbox;
  readonly directory: string;
  readonly spawnDetached: SpawnDetached | undefined;
}

// How long a restart waits for a supervisor that is still reporting its
// detached work to exit: about as long as its client waits to connect.
const EXIT_POLLS = 150;
const EXIT_POLL_MS = 100;

/** The supervisor's status once it says it has exited, or `undefined` if it never does. */
const whenExited = async (
  options: Restart,
  pollsLeft = EXIT_POLLS,
): Promise<SupervisorStatus | undefined> => {
  const status = await readSupervisorStatus(options.sandbox, options.directory);
  if (status?.supervisor === "exited") {
    return status;
  }
  if (pollsLeft === 0) {
    return undefined;
  }
  await delay(EXIT_POLL_MS);
  return whenExited(options, pollsLeft - 1);
};

/**
 * Starts a new supervisor in `directory`, once its status file says the last
 * one has exited. It marks the file `running` first, so the new supervisor's
 * client waits for it rather than giving up on the old one's `exited`.
 */
const restart = async (options: Restart): Promise<SupervisorLink> => {
  const { sandbox, directory, spawnDetached } = options;
  const status = await whenExited(options);
  if (status === undefined) {
    throw new Error("the session supervisor didn't answer, and hasn't exited");
  }
  await sandbox.writeTextFile({
    path: posix.join(directory, STATUS_FILE),
    content: JSON.stringify({ ...status, supervisor: "running" }),
  });
  return startSupervisor(sandbox, spawnDetached);
};

/**
 * A link to the supervisor in `directory` that does nothing until something
 * needs it: `status()` and `follow()` read its files and never do, which
 * matters on a busy sandbox, where starting the supervisor's client can take
 * tens of seconds. A session, a spawn or a detach says hello to the one
 * running, or restarts it when it has exited. `close()` only shuts down one
 * that's running: it never starts one to stop it.
 */
export const reattachedLink = (
  options: Restart & { readonly exited: boolean },
): SupervisorLink => {
  const { sandbox, directory } = options;
  // The running supervisor, or `undefined` once it's taken as exited.
  let live: Promise<SupervisorLink | undefined> | undefined = options.exited
    ? Promise.resolve(undefined)
    : undefined;
  let started: Promise<SupervisorLink> | undefined;
  const running = async (): Promise<SupervisorLink | undefined> => {
    live ??= linkTo(sandbox, directory).catch(() => undefined);
    return live;
  };
  const usable = async (): Promise<SupervisorLink> => {
    const found = started === undefined ? await running() : await started;
    if (found !== undefined) {
      return found;
    }
    started ??= restart(options).catch((error: unknown) => {
      // A later call may try again.
      started = undefined;
      throw error;
    });
    return started;
  };
  return {
    call: async (request, onReply, abortSignal) => {
      const { call } = await usable();
      return call(request, onReply, abortSignal);
    },
    publicKey: async () => {
      const { publicKey } = await usable();
      return publicKey();
    },
    directory,
    shutdown: async () => {
      const found = await (started ?? running()).catch(() => undefined);
      await found?.shutdown();
    },
  };
};
