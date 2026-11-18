import { posix } from "node:path";
import { DateTime } from "effect";
import { shellEscape } from "../../AgentProvider.js";
import type {
  ProviderCreateOptions,
  ProviderExecOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import type { KeeperCommand } from "./localSandboxKeeper.js";
import {
  closeKeeper,
  keeperAlive,
  keeperExec,
  keeperSpawn,
  startKeeper,
} from "./localSandboxKeeper.js";
import type { LocalSandboxFolder } from "./localSandboxState.js";
import {
  findSandboxFolder,
  makeSandboxFolder,
  removeSandboxFolder,
} from "./localSandboxState.js";

// The provider contract's view of a local sandbox (bwrap(), seatbelt()): a
// folder on the host, owned by its keeper, whose commands the keeper runs.
// A provider says only how to run one command in it: its `LocalLaunch`.

/** What a local sandbox's `native` holds. */
export interface LocalNative {
  /** The host folder behind the sandbox: its home, tmp and metadata. Removed when the sandbox ends. */
  readonly stateDirectory: string;
}

/** One command for the keeper to run in the sandbox. */
export interface LocalCommand {
  readonly command: string;
  readonly workingDirectory: string;
  readonly sudo: boolean;
  readonly env: Readonly<Record<string, string>>;
}

/** Makes each command's argv and env for one sandbox. May throw, for a command it can't run. */
export type LocalLaunch = (command: LocalCommand) => KeeperCommand;

/** How a provider runs commands in the sandbox in a folder. */
export interface LocalSetup {
  readonly launch: LocalLaunch;
  /** The working directory, as the sandbox's commands see it. */
  readonly workingDirectory: string;
}

/** How to run commands in a new sandbox's folder. */
type Prepare = (folder: LocalSandboxFolder) => Promise<LocalSetup>;

type LocalProviderSandbox = ProviderSandbox<LocalNative>;

interface LocalContext extends LocalSetup {
  readonly provider: string;
  readonly folder: LocalSandboxFolder;
  readonly env: Readonly<Record<string, string>>;
}

const contexts = new WeakMap<LocalProviderSandbox, LocalContext>();

/** Exit code of the read below when the file isn't there. */
const MISSING = 66;

const run = async (
  context: LocalContext,
  options: ProviderExecOptions,
): Promise<ReturnType<typeof keeperExec>> =>
  keeperExec(context.folder, {
    ...context.launch({
      command: options.command,
      workingDirectory: options.workingDirectory ?? context.workingDirectory,
      sudo: options.sudo === true,
      env: { ...context.env, ...options.env },
    }),
    stdin: options.stdin ?? "",
    ...(options.onLine === undefined ? {} : { onLine: options.onLine }),
    ...(options.abortSignal === undefined
      ? {}
      : { abortSignal: options.abortSignal }),
  });

/**
 * Files are read and written by a command in the sandbox, never on the
 * host: a path the sandbox controls (a symlink it made) can't lead outside it.
 */
const readText = async (
  context: LocalContext,
  path: string,
): Promise<string | null> => {
  const file = shellEscape(path);
  const result = await run(context, {
    command: `if [ -e ${file} ]; then exec cat -- ${file}; else exit ${MISSING}; fi`,
  });
  if (result.exitCode === MISSING) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${context.provider}: couldn't read ${path}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
};

const writeText = async (
  context: LocalContext,
  path: string,
  content: string,
): Promise<void> => {
  const file = shellEscape(path);
  const result = await run(context, {
    command: `mkdir -p -- ${shellEscape(posix.dirname(path))} && cat > ${file}`,
    stdin: content,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${context.provider}: couldn't write ${path}: ${result.stderr.trim()}`,
    );
  }
};

const openSandbox = (context: LocalContext): LocalProviderSandbox => {
  const { folder } = context;
  let closing: Promise<void> | undefined;
  const made: LocalProviderSandbox = {
    sandboxId: folder.sandboxId,
    workingDirectory: context.workingDirectory,
    killTime: folder.killTime,
    native: { stateDirectory: folder.path },
    exec: async (options) => run(context, options),
    readTextFile: async ({ path }) => readText(context, path),
    writeTextFile: async ({ path, content }) =>
      writeText(context, path, content),
    close: async () => {
      closing ??= closeKeeper(folder);
      return closing;
    },
  };
  contexts.set(made, context);
  return made;
};

/**
 * Makes a local sandbox: its folder, then `prepare`'s setup for it, then
 * its keeper. On any failure, removes whatever was made.
 */
export const createLocalSandbox = async (options: {
  readonly provider: string;
  readonly settings: unknown;
  readonly create: ProviderCreateOptions;
  readonly prepare: Prepare;
}): Promise<LocalProviderSandbox> => {
  const { provider, create } = options;
  const killTime = DateTime.toDateUtc(
    DateTime.add(DateTime.unsafeNow(), {
      millis: Math.round(create.timeLimitMinutes * 60_000),
    }),
  );
  const folder = await makeSandboxFolder({
    provider,
    killTime,
    settings: options.settings,
  });
  try {
    const setup = await options.prepare(folder);
    create.abortSignal?.throwIfAborted();
    await startKeeper(folder);
    create.abortSignal?.throwIfAborted();
    return openSandbox({ ...setup, provider, folder, env: create.env });
  } catch (error) {
    await closeKeeper(folder).catch(async () =>
      removeSandboxFolder(folder.path),
    );
    throw error;
  }
};

/**
 * An existing local sandbox by id, or `undefined` once it's gone: its
 * folder removed, or its keeper not running (the machine restarted), or
 * its settings unreadable (`prepare` returns `undefined`). Its commands get
 * only their own env: the sandbox's env is never written down, so
 * `reattachSandbox` takes it again.
 */
export const getLocalSandbox = async (options: {
  readonly provider: string;
  readonly sandboxId: string;
  readonly prepare: (
    folder: LocalSandboxFolder,
  ) => Promise<LocalSetup | undefined>;
}): Promise<LocalProviderSandbox | undefined> => {
  const { provider } = options;
  const folder = await findSandboxFolder(provider, options.sandboxId);
  if (folder === undefined || !(await keeperAlive(folder))) {
    return undefined;
  }
  const setup = await options.prepare(folder);
  return setup === undefined
    ? undefined
    : openSandbox({ ...setup, provider, folder, env: {} });
};

/** Starts work under the sandbox's keeper, so it outlives this process. */
export const spawnInLocalSandbox = async (
  sandbox: LocalProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(`local sandbox ${sandbox.sandboxId} is not open`);
  }
  await keeperSpawn(
    context.folder,
    context.launch({
      command: options.command,
      workingDirectory: options.workingDirectory ?? context.workingDirectory,
      sudo: false,
      env: { ...context.env, ...options.env },
    }),
  );
};
