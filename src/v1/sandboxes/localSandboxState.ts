import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Config, DateTime, Effect, Either, Option, Schema } from "effect";

// The host folder behind each local sandbox (bwrap(), and the other
// providers whose sandboxes run on this machine): its home, its tmp, and a
// metadata file with its kill time. Provider-agnostic: it knows paths and
// times, never how a provider runs a command. The sandbox's keeper
// (localSandboxKeeper.ts) owns the folder once it starts, and removes it at
// the kill time or on close.
//
//   $XDG_STATE_HOME/sandcastle/sandboxes/<sandboxId>/   (default ~/.local/state)
//     sandbox.json   metadata: id, provider, kill time, provider settings
//     keeper.sock    the keeper's socket, while it runs
//     keeper.log     the keeper's own errors
//     home/          the sandbox's home; home/workspace is its working directory
//     tmp/           the sandbox's /tmp

/** A local sandbox's host folder. */
export interface LocalSandboxFolder {
  /** The sandbox's id: also the folder's name. */
  readonly sandboxId: string;
  /** The provider that made it, e.g. `"bwrap"`: the id's prefix. */
  readonly provider: string;
  /** The folder itself. */
  readonly path: string;
  /** The host folder behind the sandbox's home. */
  readonly home: string;
  /** The host folder behind the sandbox's tmp. */
  readonly tmp: string;
  /** When the keeper ends the sandbox and removes the folder. */
  readonly killTime: Date;
  /** What the provider recorded at create, for a reattach to read back. Never env. */
  readonly settings: unknown;
}

const Metadata = Schema.Struct({
  sandboxId: Schema.String,
  provider: Schema.String,
  killTime: Schema.String,
  settings: Schema.Unknown,
});
const MetadataJson = Schema.parseJson(Metadata);
const decodeMetadata = Schema.decodeUnknownEither(MetadataJson);
const encodeMetadata = Schema.encodeEither(MetadataJson);

const METADATA = "sandbox.json";
const SANDBOX_ID = /^[a-z]+-[0-9a-f]{16}$/u;

/** The folder every local sandbox's folder sits in. */
export const sandboxesRoot = async (): Promise<string> => {
  const state = await Effect.runPromise(
    Config.string("XDG_STATE_HOME").pipe(Config.withDefault("")),
  );
  // The XDG spec says to ignore a relative value.
  const base = isAbsolute(state) ? state : join(homedir(), ".local", "state");
  return join(base, "sandcastle", "sandboxes");
};

const folderAt = (
  path: string,
  {
    sandboxId,
    provider,
    killTime,
    settings,
  }: Omit<LocalSandboxFolder, "path" | "home" | "tmp">,
): LocalSandboxFolder => ({
  sandboxId,
  provider,
  path,
  home: join(path, "home"),
  tmp: join(path, "tmp"),
  killTime,
  settings,
});

/** The keeper's socket in a sandbox's folder. */
export const keeperSocket = (folder: { readonly path: string }): string =>
  join(folder.path, "keeper.sock");

/** The keeper's log in a sandbox's folder. */
export const keeperLog = (folder: { readonly path: string }): string =>
  join(folder.path, "keeper.log");

/**
 * Makes a new sandbox's folder, readable only by this user: an empty home
 * with an empty `workspace`, an empty tmp, and the metadata.
 */
export const makeSandboxFolder = async (options: {
  readonly provider: string;
  readonly killTime: Date;
  readonly settings: unknown;
}): Promise<LocalSandboxFolder> => {
  const sandboxId = `${options.provider}-${randomBytes(8).toString("hex")}`;
  const root = await sandboxesRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, sandboxId);
  await mkdir(path, { mode: 0o700 });
  const folder = folderAt(path, {
    sandboxId,
    provider: options.provider,
    killTime: options.killTime,
    settings: options.settings,
  });
  await mkdir(join(folder.home, "workspace"), { recursive: true });
  await mkdir(folder.tmp);
  const metadata = encodeMetadata({
    sandboxId,
    provider: options.provider,
    killTime: options.killTime.toISOString(),
    settings: options.settings,
  });
  if (Either.isLeft(metadata)) {
    throw new TypeError(
      `local sandbox: unwritable settings: ${metadata.left.message}`,
    );
  }
  await writeFile(join(path, METADATA), metadata.right, { mode: 0o600 });
  return folder;
};

/** The folder at `path`, or `undefined` when its metadata is missing or unreadable. */
export const readSandboxFolder = async (
  path: string,
): Promise<LocalSandboxFolder | undefined> => {
  const text = await readFile(join(path, METADATA), "utf8").catch(
    () => undefined,
  );
  const metadata = text === undefined ? undefined : decodeMetadata(text);
  if (metadata === undefined || Either.isLeft(metadata)) {
    return undefined;
  }
  const { sandboxId, provider, killTime, settings } = metadata.right;
  const time = DateTime.make(killTime);
  return Option.isNone(time)
    ? undefined
    : folderAt(path, {
        sandboxId,
        provider,
        killTime: DateTime.toDateUtc(time.value),
        settings,
      });
};

/** A sandbox's folder by its id, or `undefined` when `provider` made none by that id. */
export const findSandboxFolder = async (
  provider: string,
  sandboxId: string,
): Promise<LocalSandboxFolder | undefined> => {
  if (!SANDBOX_ID.test(sandboxId) || !sandboxId.startsWith(`${provider}-`)) {
    return undefined;
  }
  const folder = await readSandboxFolder(
    join(await sandboxesRoot(), sandboxId),
  );
  return folder?.sandboxId === sandboxId && folder.provider === provider
    ? folder
    : undefined;
};

/** Gives this user write access to every folder under `path`, so it can be removed. */
const makeRemovable = async (path: string): Promise<void> => {
  await chmod(path, 0o700).catch(() => undefined);
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => makeRemovable(join(path, entry.name))),
  );
};

/**
 * Removes a sandbox's folder, even where the sandbox took write access
 * away from folders in it. Never follows a symlink out of it. A folder
 * already gone counts as removed.
 */
export const removeSandboxFolder = async (path: string): Promise<void> => {
  const removed = await rm(path, { recursive: true, force: true }).then(
    () => true,
    () => false,
  );
  if (!removed) {
    await makeRemovable(path);
    await rm(path, { recursive: true, force: true });
  }
};
