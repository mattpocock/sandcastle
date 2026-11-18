import { posix } from "node:path";
import { DateTime, Either, Schema } from "effect";
import { shellEscape } from "../../AgentProvider.js";
import { assertBwrapUsable } from "../../bwrapPreflight.js";
import type {
  ProviderCreateOptions,
  ProviderExecOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import type { BwrapLaunch, BwrapSettings } from "./bwrapArgs.js";
import { BWRAP_WORKSPACE, bwrapLaunch } from "./bwrapArgs.js";
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

// Making, finding and closing bwrap() sandboxes, and the provider
// contract's view of one. Each sandbox is a folder on the host, owned by its
// keeper; each command is a fresh Bubblewrap over that folder, run by the
// keeper.

/** What a bwrap() sandbox's `native` holds. */
export interface BwrapNative {
  /** The host folder behind the sandbox: its home, tmp and metadata. Removed when the sandbox ends. */
  readonly stateDirectory: string;
}

type BwrapProviderSandbox = ProviderSandbox<BwrapNative>;

/** What each sandbox's commands need, kept off the public object. */
interface BwrapContext {
  readonly folder: LocalSandboxFolder;
  readonly launch: BwrapLaunch;
  readonly env: Readonly<Record<string, string>>;
}

const contexts = new WeakMap<BwrapProviderSandbox, BwrapContext>();

const Settings = Schema.Struct({
  network: Schema.Literal("host", "none"),
  toolchainPaths: Schema.Array(Schema.String),
});
const decodeSettings = Schema.decodeUnknownEither(Settings);

/** Exit code of the read below when the file isn't there. */
const MISSING = 66;

const run = async (
  context: BwrapContext,
  options: ProviderExecOptions,
): Promise<ReturnType<typeof keeperExec>> =>
  keeperExec(context.folder, {
    ...context.launch({
      command: options.command,
      workingDirectory: options.workingDirectory ?? BWRAP_WORKSPACE,
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
  context: BwrapContext,
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
    throw new Error(`bwrap: couldn't read ${path}: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

const writeText = async (
  context: BwrapContext,
  path: string,
  content: string,
): Promise<void> => {
  const file = shellEscape(path);
  const result = await run(context, {
    command: `mkdir -p -- ${shellEscape(posix.dirname(path))} && cat > ${file}`,
    stdin: content,
  });
  if (result.exitCode !== 0) {
    throw new Error(`bwrap: couldn't write ${path}: ${result.stderr.trim()}`);
  }
};

const openSandbox = (context: BwrapContext): BwrapProviderSandbox => {
  const { folder } = context;
  let closing: Promise<void> | undefined;
  const made: BwrapProviderSandbox = {
    sandboxId: folder.sandboxId,
    workingDirectory: BWRAP_WORKSPACE,
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

/** Makes a bwrap() sandbox; on any failure, removes whatever was made. */
export const createBwrapSandbox = async (
  settings: BwrapSettings,
  options: ProviderCreateOptions,
): Promise<BwrapProviderSandbox> => {
  assertBwrapUsable();
  const killTime = DateTime.toDateUtc(
    DateTime.add(DateTime.unsafeNow(), {
      millis: Math.round(options.timeLimitMinutes * 60_000),
    }),
  );
  const folder = await makeSandboxFolder({
    provider: "bwrap",
    killTime,
    settings,
  });
  try {
    const launch = await bwrapLaunch(folder, settings);
    options.abortSignal?.throwIfAborted();
    await startKeeper(folder);
    options.abortSignal?.throwIfAborted();
    return openSandbox({ folder, launch, env: options.env });
  } catch (error) {
    await closeKeeper(folder).catch(async () =>
      removeSandboxFolder(folder.path),
    );
    throw error;
  }
};

/**
 * An existing bwrap() sandbox by id, or `undefined` once it's gone: its
 * folder removed, or its keeper not running (the machine restarted). Its
 * commands get only their own env: the sandbox's env is never written
 * down, so `reattachSandbox` takes it again.
 */
export const getBwrapSandbox = async (
  sandboxId: string,
): Promise<BwrapProviderSandbox | undefined> => {
  const folder = await findSandboxFolder(sandboxId);
  if (folder === undefined || !(await keeperAlive(folder))) {
    return undefined;
  }
  const settings = decodeSettings(folder.settings);
  if (Either.isLeft(settings)) {
    return undefined;
  }
  const launch = await bwrapLaunch(folder, settings.right);
  return openSandbox({ folder, launch, env: {} });
};

/** Starts work under the sandbox's keeper, so it outlives this process. */
export const spawnInBwrapSandbox = async (
  sandbox: BwrapProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(`bwrap: ${sandbox.sandboxId} is not open`);
  }
  await keeperSpawn(
    context.folder,
    context.launch({
      command: options.command,
      workingDirectory: options.workingDirectory ?? BWRAP_WORKSPACE,
      sudo: false,
      env: { ...context.env, ...options.env },
    }),
  );
};
