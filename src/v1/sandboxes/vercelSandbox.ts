import { posix } from "node:path";
import type { Sandbox as VercelSandbox } from "@vercel/sandbox";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import type { VercelAuthOptions } from "./vercelAuth.js";
import type { VercelExecContext } from "./vercelExec.js";
import {
  makeDirectory,
  spawnDetachedCommand,
  vercelExec,
} from "./vercelExec.js";

// Making, finding and closing Vercel sandboxes, and the provider contract's
// view of one.

/** `@vercel/sandbox`'s `Sandbox` class: where sandboxes are made and found. */
export type VercelSdk = typeof VercelSandbox;

/**
 * `@vercel/sandbox`'s own params for `Sandbox.create` (image, source,
 * resources, ports, region, `networkPolicy`…), without the fields Sandcastle
 * sets itself: `timeout` comes from `timeLimitMinutes`; env goes to each
 * command, never to the sandbox (`env`); `persistent` is always `false`, so
 * stopping a sandbox leaves no snapshot behind; and auth comes from
 * `vercel()`'s own options (`token`, `teamId`, `projectId`).
 */
export type VercelCreateOptions =
  NonNullable<
    Parameters<(typeof VercelSandbox)["create"]>[0]
  > extends infer Params
    ? Params extends unknown
      ? Omit<
          Params,
          "timeout" | "env" | "persistent" | "token" | "teamId" | "projectId"
        >
      : never
    : never;

type VercelProviderSandbox = ProviderSandbox<VercelSandbox>;

/** What each sandbox's commands need, kept off the public object. */
const contexts = new WeakMap<VercelProviderSandbox, VercelExecContext>();

/** Sandbox states that will never run a command again. */
const ENDED = new Set(["stopping", "stopped", "failed", "aborted"]);

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "response" in error &&
  typeof error.response === "object" &&
  error.response !== null &&
  "status" in error.response &&
  error.response.status === 404;

/** Stops a sandbox; one that's already gone counts as stopped. */
const stopSandbox = async (sandbox: VercelSandbox): Promise<void> => {
  await sandbox.stop().catch((error: unknown) => {
    if (!isNotFound(error)) {
      throw error;
    }
  });
};

/**
 * The directory commands start in: `sandbox/workspace` under the session's
 * own directory (`/vercel` on the default image), so a clone into it starts
 * empty.
 */
const workspaceOf = (sandbox: VercelSandbox): string =>
  posix.join(sandbox.cwd || "/vercel", "sandbox", "workspace");

/** When Vercel will stop the sandbox: its timeout, read back. */
const killTimeOf = (sandbox: VercelSandbox): Date => {
  const { expiresAt } = sandbox;
  if (expiresAt === undefined) {
    throw new Error(
      "Vercel didn't report when the sandbox will stop (expiresAt). Sandcastle needs @vercel/sandbox 3.8.0 or later.",
    );
  }
  return expiresAt;
};

const openSandbox = (
  sandbox: VercelSandbox,
  env: Readonly<Record<string, string>>,
): VercelProviderSandbox => {
  const workingDirectory = workspaceOf(sandbox);
  const context = { sandbox, workingDirectory, env };
  let closing: Promise<void> | undefined;
  const made: VercelProviderSandbox = {
    sandboxId: sandbox.name,
    workingDirectory,
    killTime: killTimeOf(sandbox),
    native: sandbox,
    exec: async (options) => vercelExec(context, options),
    readTextFile: async ({ path }) => {
      const content = await sandbox.readFileToBuffer({ path });
      return content === null ? null : content.toString("utf8");
    },
    writeTextFile: async ({ path, content }) => {
      await sandbox.writeFiles([{ path, content: Buffer.from(content) }]);
    },
    close: async () => {
      closing ??= stopSandbox(sandbox);
      return closing;
    },
  };
  contexts.set(made, context);
  return made;
};

/** Makes a Vercel sandbox; on any failure after Vercel made it, stops it. */
export const createVercelSandbox = async (
  sdk: VercelSdk,
  {
    create,
    auth,
  }: {
    readonly create: VercelCreateOptions | undefined;
    readonly auth: VercelAuthOptions;
  },
  options: ProviderCreateOptions,
): Promise<VercelProviderSandbox> => {
  const sandbox = await sdk.create({
    ...create,
    ...auth,
    timeout: Math.max(1000, Math.round(options.timeLimitMinutes * 60_000)),
    // Vercel's default is persistent, which snapshots the sandbox on every
    // stop; the snapshots are kept, and count against the account's storage.
    persistent: false,
  });
  try {
    options.abortSignal?.throwIfAborted();
    await makeDirectory(sandbox, workspaceOf(sandbox));
    return openSandbox(sandbox, options.env);
  } catch (error) {
    await stopSandbox(sandbox).catch(() => undefined);
    throw error;
  }
};

/**
 * An existing Vercel sandbox by name, read afresh (so its kill time takes in
 * any extension), or `undefined` once it has stopped or is gone. Its
 * commands get only their own env: the env it was created with isn't kept
 * anywhere it could be read back from, so `reattachSandbox` takes it again.
 */
export const getVercelSandbox = async (
  sdk: VercelSdk,
  auth: VercelAuthOptions,
  sandboxId: string,
): Promise<VercelProviderSandbox | undefined> => {
  const sandbox = await sdk
    .get({ ...auth, name: sandboxId })
    .catch((error: unknown) => {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    });
  if (sandbox === undefined || ENDED.has(sandbox.status)) {
    return undefined;
  }
  return openSandbox(sandbox, {});
};

/** Starts work in a detached command that outlives the host's hold on the sandbox. */
export const spawnInVercelSandbox = async (
  sandbox: VercelProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(`vercel: ${sandbox.sandboxId} is not open`);
  }
  await spawnDetachedCommand(context, options);
};
