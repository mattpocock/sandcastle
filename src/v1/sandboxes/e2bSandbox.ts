import { posix } from "node:path";
import { DateTime } from "effect";
import type { Sandbox as E2BSandbox, SandboxOpts } from "e2b";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import type { E2BExecContext } from "./e2bExec.js";
import { e2bExec, e2bSpawnDetached, isNotFound } from "./e2bExec.js";

// Making, finding and closing E2B sandboxes, and the provider contract's view
// of one.

/**
 * `e2b`'s own options for `Sandbox.create` (template, metadata, network
 * rules, volume mounts…), without the fields Sandcastle sets itself: the
 * sandbox's lifetime (`timeoutMs`) comes from `timeLimitMinutes`, and it is
 * always killed, never paused, when that runs out (`lifecycle`); env goes to
 * each command, never to the sandbox (`envs`); and the credentials and
 * domain are `e2b()`'s own options (`apiKey`, `domain`).
 */
export type E2BCreateOptions = Omit<
  SandboxOpts,
  "envs" | "timeoutMs" | "lifecycle" | "apiKey" | "domain"
>;

/** How to reach E2B: only the connection options that are set. */
export interface E2BConnection {
  readonly apiKey?: string;
  readonly domain?: string;
}

/** The template a sandbox is made from unless `create` names one: it has Node and Claude Code. */
export const DEFAULT_TEMPLATE = "claude";

/** `e2b`'s `Sandbox` class, loaded at runtime. */
type E2BSandboxClass = typeof E2BSandbox;
type E2BProviderSandbox = ProviderSandbox<E2BSandbox>;

/** What each sandbox's commands need, kept off the public object. */
const contexts = new WeakMap<E2BProviderSandbox, E2BExecContext>();

/** Kills a sandbox; one that's already gone counts as killed. */
const killSandbox = async (sandbox: E2BSandbox): Promise<void> => {
  await sandbox.kill().then(
    () => undefined,
    (error: unknown) => {
      if (!isNotFound(error)) {
        throw error;
      }
    },
  );
};

/** When E2B will kill the sandbox, read back from the sandbox itself. */
const killTimeOf = async (sandbox: E2BSandbox): Promise<Date> => {
  const { endAt } = await sandbox.getInfo();
  return DateTime.toDateUtc(DateTime.unsafeMake(endAt));
};

/** `$HOME/workspace` for the sandbox's user, made if it isn't there, so a clone into it starts empty. */
const workspaceOf = async (sandbox: E2BSandbox): Promise<string> => {
  const made = await sandbox.commands.run(
    'mkdir -p "$HOME/workspace" && cd "$HOME/workspace" && pwd',
    { timeoutMs: 0 },
  );
  const workingDirectory = made.stdout.trim();
  if (!posix.isAbsolute(workingDirectory)) {
    throw new Error(
      `e2b: could not find $HOME/workspace in the sandbox (got "${workingDirectory}")`,
    );
  }
  return workingDirectory;
};

const openSandbox = (
  sandbox: E2BSandbox,
  {
    workingDirectory,
    env,
    killTime,
  }: Omit<E2BExecContext, "sandbox"> & {
    readonly killTime: Date;
  },
): E2BProviderSandbox => {
  const context = { sandbox, workingDirectory, env };
  let closing: Promise<void> | undefined;
  const made: E2BProviderSandbox = {
    sandboxId: sandbox.sandboxId,
    workingDirectory,
    killTime,
    native: sandbox,
    exec: async (options) => e2bExec(context, options),
    readTextFile: async ({ path }) =>
      sandbox.files.read(path).then(
        (content) => content,
        (error: unknown) => {
          if (isNotFound(error)) {
            return null;
          }
          throw error;
        },
      ),
    writeTextFile: async ({ path, content }) => {
      await sandbox.files.write(path, content);
    },
    close: async () => {
      closing ??= killSandbox(sandbox);
      return closing;
    },
  };
  contexts.set(made, context);
  return made;
};

/** The SDK's create options: the caller's, plus the fields Sandcastle controls. */
const sdkCreateOptions = (
  connection: E2BConnection,
  create: E2BCreateOptions | undefined,
  timeLimitMinutes: number,
): SandboxOpts => ({
  template: DEFAULT_TEMPLATE,
  ...create,
  ...connection,
  timeoutMs: Math.round(timeLimitMinutes * 60_000),
  // Paused, the session supervisor couldn't report that time ran out.
  lifecycle: { onTimeout: "kill", autoResume: false },
});

/** Makes an E2B sandbox; on any failure after E2B made it, kills it. */
export const createE2BSandbox = async (
  Sandbox: E2BSandboxClass,
  {
    connection,
    create,
    options,
  }: {
    readonly connection: E2BConnection;
    readonly create: E2BCreateOptions | undefined;
    readonly options: ProviderCreateOptions;
  },
): Promise<E2BProviderSandbox> => {
  const sandbox = await Sandbox.create(
    sdkCreateOptions(connection, create, options.timeLimitMinutes),
  );
  try {
    options.abortSignal?.throwIfAborted();
    const killTime = await killTimeOf(sandbox);
    const workingDirectory = await workspaceOf(sandbox);
    return openSandbox(sandbox, {
      workingDirectory,
      env: options.env,
      killTime,
    });
  } catch (error) {
    await killSandbox(sandbox).catch(() => undefined);
    throw error;
  }
};

/** Milliseconds until `endAt`, rounded down to whole seconds as E2B counts them. */
const remainingOf = (endAt: Date): number =>
  Math.floor((endAt.getTime() - DateTime.unsafeNow().epochMillis) / 1000) *
  1000;

/** `undefined` for a not-found error; any other is rethrown. */
const notFound = (error: unknown): undefined => {
  if (isNotFound(error)) {
    return undefined;
  }
  throw error;
};

/**
 * An existing E2B sandbox by id, or `undefined` once it's gone. Connecting
 * can only lengthen a running sandbox's timeout, never shorten it, so it asks
 * for exactly the time that's left: a reattach never moves the kill time.
 * Its commands get only their own env: the env the sandbox was created with
 * isn't kept anywhere it could be read back from, so `reattachSandbox` takes
 * it again.
 */
export const getE2BSandbox = async (
  Sandbox: E2BSandboxClass,
  connection: E2BConnection,
  sandboxId: string,
): Promise<E2BProviderSandbox | undefined> => {
  const info = await Sandbox.getInfo(sandboxId, connection).catch(notFound);
  const remaining = info === undefined ? 0 : remainingOf(info.endAt);
  if (info === undefined || info.state !== "running" || remaining <= 0) {
    return undefined;
  }
  const sandbox = await Sandbox.connect(sandboxId, {
    ...connection,
    timeoutMs: remaining,
  }).catch(notFound);
  if (sandbox === undefined) {
    return undefined;
  }
  return openSandbox(sandbox, {
    workingDirectory: await workspaceOf(sandbox),
    env: {},
    killTime: await killTimeOf(sandbox),
  });
};

/** Starts work in the background that outlives the host's hold on the sandbox. */
export const spawnInE2BSandbox = async (
  sandbox: E2BProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(`e2b: ${sandbox.sandboxId} is not open`);
  }
  await e2bSpawnDetached(context, options);
};
