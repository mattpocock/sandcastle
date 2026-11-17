import { posix } from "node:path";
import { DateTime } from "effect";
import type {
  Image,
  ModalClient,
  Sandbox as ModalSandbox,
  SandboxCreateParams,
} from "modal";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import type { ModalExecContext, ModalUser } from "./modalExec.js";
import { modalExec, modalSpawnDetached, modalWriteText } from "./modalExec.js";
import {
  MODAL_STATE_PATH,
  readModalState,
  writeModalState,
} from "./modalState.js";

// Making, finding and closing Modal sandboxes, and the provider contract's
// view of one.

/**
 * `modal`'s own params for creating a sandbox (`cpu`, `memoryMiB`, `regions`,
 * `blockNetwork`, `outboundCidrAllowlist`, `volumes`, …), without the fields
 * Sandcastle sets itself: the lifetime (`timeoutMs`) comes from
 * `timeLimitMinutes`, and there's no idle timeout (`idleTimeoutMs`), so a
 * sandbox the host has let go of isn't ended for want of calls. Env goes to
 * each command, never to the sandbox (`env`), and `secrets` would put values
 * in the sandbox Sandcastle can't redact.
 */
export type ModalCreateOptions = Omit<
  SandboxCreateParams,
  "timeoutMs" | "idleTimeoutMs" | "env" | "secrets"
>;

type ModalProviderSandbox = ProviderSandbox<ModalSandbox>;

/** Where commands start. */
export const MODAL_WORKING_DIRECTORY = "/workspace";

/** Modal's cap on a sandbox's lifetime: 24 hours. */
const MAX_TIME_LIMIT_MINUTES = 24 * 60;

/** The non-root user commands run as, in an image that has it. */
const SANDBOX_USER = "sandcastle";

/** What each sandbox's commands need, kept off the public object. */
const contexts = new WeakMap<ModalProviderSandbox, ModalExecContext>();

const isGone = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "ClientError" &&
  "code" in error &&
  // NOT_FOUND, or INVALID_ARGUMENT for an id that can't be one.
  (error.code === 5 || error.code === 3);

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && error.name === "SandboxFilesystemNotFoundError";

/** Terminates a sandbox and closes its client. Never rejects for one that's already gone. */
const terminate = async (
  client: ModalClient,
  sandbox: ModalSandbox,
): Promise<void> => {
  try {
    await sandbox.terminate().catch((error: unknown) => {
      if (!isGone(error)) {
        throw error;
      }
    });
  } finally {
    client.close();
  }
};

const openSandbox = (
  client: ModalClient,
  context: ModalExecContext,
  killTime: Date,
): ModalProviderSandbox => {
  const { sandbox } = context;
  let closing: Promise<void> | undefined;
  const made: ModalProviderSandbox = {
    sandboxId: sandbox.sandboxId,
    workingDirectory: context.workingDirectory,
    killTime,
    native: sandbox,
    exec: async (options) => modalExec(context, options),
    readTextFile: async ({ path }) =>
      sandbox.filesystem.readText(path).catch((error: unknown) => {
        if (isMissingFile(error)) {
          return null;
        }
        throw error;
      }),
    writeTextFile: async (options) => modalWriteText(context, options),
    close: async () => {
      closing ??= terminate(client, sandbox);
      return closing;
    },
  };
  contexts.set(made, context);
  return made;
};

/**
 * Makes the working directory and the state folder, as root, and finds the
 * sandbox user: there when the image has it and `setpriv`. The working
 * directory is then the user's.
 */
const prepare = async (
  sandbox: ModalSandbox,
): Promise<ModalUser | undefined> => {
  const process = await sandbox.exec([
    "sh",
    "-c",
    [
      `mkdir -p ${MODAL_WORKING_DIRECTORY} ${posix.dirname(MODAL_STATE_PATH)} || exit 1`,
      `if command -v setpriv >/dev/null 2>&1 && getent passwd ${SANDBOX_USER}; then chown ${SANDBOX_USER}: ${MODAL_WORKING_DIRECTORY} || exit 1; fi`,
    ].join("\n"),
  ]);
  await process.stdin.close();
  const [stdout, stderr] = await Promise.all([
    process.stdout.readText(),
    process.stderr.readText(),
  ]);
  if ((await process.wait()) !== 0) {
    throw new Error(
      `modal: could not make ${MODAL_WORKING_DIRECTORY}: ${stderr}`,
    );
  }
  // getent: name:password:uid:gid:gecos:home:shell
  const home = stdout.trim().split(":").at(5);
  return home === undefined || home === ""
    ? undefined
    : { name: SANDBOX_USER, home };
};

/** Modal's lifetime for a sandbox, in whole seconds as it requires. */
const timeoutMsOf = (timeLimitMinutes: number): number => {
  if (timeLimitMinutes > MAX_TIME_LIMIT_MINUTES) {
    throw new RangeError(
      `modal: timeLimitMinutes is at most ${MAX_TIME_LIMIT_MINUTES} (24 hours, Modal's cap), got ${timeLimitMinutes}`,
    );
  }
  return Math.ceil(timeLimitMinutes * 60) * 1000;
};

/** Everything `createModalSandbox` needs, from the factory. */
export interface ModalCreateInput {
  readonly client: ModalClient;
  readonly appName: string;
  readonly image: Image;
  readonly create: ModalCreateOptions | undefined;
}

/** Makes a Modal sandbox; on any failure, terminates whatever was made. */
export const createModalSandbox = async (
  { client, appName, image, create }: ModalCreateInput,
  options: ProviderCreateOptions,
): Promise<ModalProviderSandbox> => {
  const timeoutMs = timeoutMsOf(options.timeLimitMinutes);
  // Read before the create call, so the kill time reported is never late.
  const killTime = DateTime.toDateUtc(
    DateTime.add(DateTime.unsafeNow(), { millis: timeoutMs }),
  );
  const sandbox = await (async () => {
    const app = await client.apps.fromName(appName, { createIfMissing: true });
    return client.sandboxes.create(app, image, {
      // Sleeps until the time limit: the sandbox ends when this command does.
      command: ["sleep", "infinity"],
      ...create,
      timeoutMs,
    });
  })().catch((error: unknown) => {
    client.close();
    throw error;
  });
  try {
    options.abortSignal?.throwIfAborted();
    const user = await prepare(sandbox);
    await writeModalState(sandbox, { killTime, user });
    options.abortSignal?.throwIfAborted();
    const context = {
      sandbox,
      workingDirectory: MODAL_WORKING_DIRECTORY,
      env: options.env,
      user,
    };
    return openSandbox(client, context, killTime);
  } catch (error) {
    await terminate(client, sandbox).catch(() => undefined);
    throw error;
  }
};

/**
 * An existing Modal sandbox by id, or `undefined` once it has finished. Its
 * kill time and user come from the state file written at create. Its
 * commands get only their own env, so `reattachSandbox` takes it again.
 */
export const getModalSandbox = async (
  client: ModalClient,
  sandboxId: string,
): Promise<ModalProviderSandbox | undefined> => {
  const sandbox = await client.sandboxes.fromId(sandboxId);
  const found = await (async () => {
    const exitCode = await sandbox.poll();
    return exitCode === null ? readModalState(sandbox) : undefined;
  })().catch((error: unknown) => {
    if (isGone(error)) {
      return undefined;
    }
    client.close();
    throw error;
  });
  if (found === undefined) {
    client.close();
    return undefined;
  }
  const context = {
    sandbox,
    workingDirectory: MODAL_WORKING_DIRECTORY,
    env: {},
    user: found.user,
  };
  return openSandbox(client, context, found.killTime);
};

/** Starts work in a Modal sandbox that outlives the host's hold on it. */
export const spawnInModalSandbox = async (
  sandbox: ModalProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(`modal: ${sandbox.sandboxId} is not open`);
  }
  await modalSpawnDetached(context, options);
};
