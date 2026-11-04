import { posix } from "node:path";
import { DateTime } from "effect";
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Daytona as DaytonaClient,
  Sandbox as DaytonaSandbox,
} from "@daytona/sdk";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import type { DaytonaExecContext } from "./daytonaExec.js";
import { daytonaExec, spawnInSession } from "./daytonaExec.js";

// Making, finding and closing Daytona sandboxes, and the provider contract's
// view of one.

/**
 * `@daytona/sdk`'s own params for creating a sandbox, from a snapshot or an
 * image (size, region, labels, network limits…), without the fields
 * Sandcastle sets itself: auto-stop and auto-pause are off, so a session the
 * host has let go of isn't stopped for want of API calls; the TTL
 * (`ttlMinutes`) comes from `timeLimitMinutes`; and env goes to each command,
 * never to the sandbox (`envVars`).
 */
export type DaytonaCreateOptions =
  | Omit<
      CreateSandboxFromSnapshotParams,
      "autoStopInterval" | "autoPauseInterval" | "ttlMinutes" | "envVars"
    >
  | Omit<
      CreateSandboxFromImageParams,
      "autoStopInterval" | "autoPauseInterval" | "ttlMinutes" | "envVars"
    >;

type DaytonaProviderSandbox = ProviderSandbox<DaytonaSandbox>;

/** What each sandbox's commands need, kept off the public object. */
const contexts = new WeakMap<DaytonaProviderSandbox, DaytonaExecContext>();

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "statusCode" in error &&
  error.statusCode === 404;

/** Deletes a sandbox; one that's already gone counts as deleted. */
const deleteSandbox = async (
  client: DaytonaClient,
  sandbox: DaytonaSandbox,
): Promise<void> => {
  await client.delete(sandbox).catch((error: unknown) => {
    if (!isNotFound(error)) {
      throw error;
    }
  });
};

/**
 * The directory commands start in: a `workspace` folder in the sandbox's
 * work dir, so a clone into it starts empty.
 */
const workspaceOf = async (sandbox: DaytonaSandbox): Promise<string> => {
  const workDir =
    (await sandbox.getWorkDir()) ??
    (await sandbox.getUserHomeDir()) ??
    "/home/daytona";
  return posix.join(workDir, "workspace");
};

/** When Daytona will destroy the sandbox: its TTL, read back. */
const killTimeOf = (sandbox: DaytonaSandbox): Date => {
  if (sandbox.autoDestroyAt === undefined || sandbox.autoDestroyAt === "") {
    throw new Error(
      "Daytona didn't report when the sandbox will be destroyed (autoDestroyAt). Sandcastle needs @daytona/sdk 0.199.0 or later.",
    );
  }
  return DateTime.toDateUtc(DateTime.unsafeMake(sandbox.autoDestroyAt));
};

const openSandbox = (
  client: DaytonaClient,
  sandbox: DaytonaSandbox,
  { workingDirectory, env }: Omit<DaytonaExecContext, "sandbox">,
): DaytonaProviderSandbox => {
  const context = { sandbox, workingDirectory, env };
  const pathOf = (path: string) => posix.resolve(workingDirectory, path);
  let closing: Promise<void> | undefined;
  const made: DaytonaProviderSandbox = {
    sandboxId: sandbox.id,
    workingDirectory,
    killTime: killTimeOf(sandbox),
    native: sandbox,
    exec: async (options) => daytonaExec(context, options),
    readTextFile: async ({ path }) =>
      sandbox.fs.downloadFile(pathOf(path)).then(
        (content) => content.toString("utf8"),
        (error: unknown) => {
          if (isNotFound(error)) {
            return null;
          }
          throw error;
        },
      ),
    writeTextFile: async ({ path, content }) => {
      await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), pathOf(path));
    },
    close: async () => {
      closing ??= deleteSandbox(client, sandbox);
      return closing;
    },
  };
  contexts.set(made, context);
  return made;
};

/** The id of a sandbox Daytona made before `create` failed (a start timeout), if it says. */
const orphanOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "sandboxId" in error &&
  typeof error.sandboxId === "string"
    ? error.sandboxId
    : undefined;

/** Deletes a sandbox Daytona made before `create` failed. */
const deleteOrphan = async (
  client: DaytonaClient,
  error: unknown,
): Promise<void> => {
  const sandboxId = orphanOf(error);
  if (sandboxId !== undefined) {
    await client
      .get(sandboxId)
      .then(async (orphan) => deleteSandbox(client, orphan))
      .catch(() => undefined);
  }
};

/** The SDK's create params: the caller's, plus the fields Sandcastle controls. */
const sdkCreate = async (
  client: DaytonaClient,
  create: DaytonaCreateOptions | undefined,
  timeLimitMinutes: number,
): Promise<DaytonaSandbox> => {
  const controlled = {
    autoStopInterval: 0,
    autoPauseInterval: 0,
    // Daytona's TTL is whole minutes; the kill time is read back exactly.
    ttlMinutes: Math.max(1, Math.ceil(timeLimitMinutes)),
  };
  // `client.create` is overloaded per params shape, so call the overload that
  // matches instead of passing the union.
  return create !== undefined && "image" in create
    ? client.create({ ...create, ...controlled })
    : client.create({ ...create, ...controlled });
};

/** Makes a Daytona sandbox; on any failure, deletes whatever was made. */
export const createDaytonaSandbox = async (
  client: DaytonaClient,
  create: DaytonaCreateOptions | undefined,
  options: ProviderCreateOptions,
): Promise<DaytonaProviderSandbox> => {
  const sandbox = await sdkCreate(
    client,
    create,
    options.timeLimitMinutes,
  ).catch(async (error: unknown) => {
    await deleteOrphan(client, error);
    throw error;
  });
  try {
    options.abortSignal?.throwIfAborted();
    const workingDirectory = await workspaceOf(sandbox);
    await sandbox.fs.createFolder(workingDirectory, "755");
    return openSandbox(client, sandbox, {
      workingDirectory,
      env: options.env,
    });
  } catch (error) {
    await deleteSandbox(client, sandbox).catch(() => undefined);
    throw error;
  }
};

/**
 * An existing Daytona sandbox by id, or `undefined` once it's gone. Its
 * commands get only their own env: the env the sandbox was created with
 * isn't kept anywhere it could be read back from.
 */
export const getDaytonaSandbox = async (
  client: DaytonaClient,
  sandboxId: string,
): Promise<DaytonaProviderSandbox | undefined> => {
  const sandbox = await client.get(sandboxId).catch((error: unknown) => {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  });
  if (sandbox === undefined || sandbox.state === "destroyed") {
    return undefined;
  }
  return openSandbox(client, sandbox, {
    workingDirectory: await workspaceOf(sandbox),
    env: {},
  });
};

/** Starts work in a Daytona session that outlives the host's hold on the sandbox. */
export const spawnInDaytonaSandbox = async (
  sandbox: DaytonaProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(`daytona: ${sandbox.sandboxId} is not open`);
  }
  await spawnInSession(context, options);
};
