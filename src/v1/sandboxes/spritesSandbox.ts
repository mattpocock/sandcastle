import { posix } from "node:path";
import type { CreateSpriteOptions, Sprite, SpritesClient } from "@fly/sprites";
import type {
  ProviderCreateOptions,
  ProviderSandbox,
} from "../SandboxProvider.js";
import { spawnInSprite } from "./spritesDetach.js";
import type { SpritesExecContext } from "./spritesExec.js";
import { spritesExec } from "./spritesExec.js";
import { newSpriteName, parseSpriteName } from "./spritesName.js";
import { registerSpriteDeletion } from "./spritesShutdown.js";

// Making, finding and closing sprites, and the provider contract's view of
// one.

/**
 * `@fly/sprites`' own options for creating a sprite (`config` for its size
 * and region, `labels`, `urlSettings`…), without the fields Sandcastle sets
 * itself: the name, which carries the kill time, and `environment`, since
 * env goes to each command, never to the sprite.
 */
export type SpritesCreateOptions = Omit<CreateSpriteOptions, "environment">;

/** The sprite user's home, where the working directory lives. */
const SPRITE_HOME = "/home/sprite";
/** The directory commands start in. */
const WORKSPACE = posix.join(SPRITE_HOME, "workspace");

type SpritesProviderSandbox = ProviderSandbox<Sprite>;

/** What each sandbox's commands need, kept off the public object. */
const contexts = new WeakMap<
  SpritesProviderSandbox,
  SpritesExecContext & { readonly killTime: Date }
>();

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("statusCode" in error && error.statusCode === 404) ||
    ("code" in error && error.code === "ENOENT"));

/** Deletes a sprite; one that's already gone counts as deleted. */
const deleteSprite = async (
  client: SpritesClient,
  name: string,
): Promise<void> => {
  await client.deleteSprite(name).catch((error: unknown) => {
    if (!isNotFound(error)) {
      throw error;
    }
  });
};

const openSandbox = (
  client: SpritesClient,
  sprite: Sprite,
  {
    killTime,
    env,
  }: {
    readonly killTime: Date;
    readonly env: Readonly<Record<string, string>>;
  },
): SpritesProviderSandbox => {
  const context = { sprite, workingDirectory: WORKSPACE, env, killTime };
  const fs = sprite.filesystem();
  let closing: Promise<void> | undefined;
  const made: SpritesProviderSandbox = {
    sandboxId: sprite.name,
    workingDirectory: WORKSPACE,
    killTime,
    native: sprite,
    exec: async (options) => spritesExec(context, options),
    readTextFile: async ({ path }) =>
      fs.readFile(path, "utf8").catch((error: unknown) => {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }),
    writeTextFile: async ({ path, content }) => {
      await fs.writeFile(path, content);
    },
    close: async () => {
      closing ??= deleteSprite(client, sprite.name);
      return closing;
    },
  };
  contexts.set(made, context);
  return made;
};

/** Makes the working directory as the sprite user, so a clone into it starts empty. */
const makeWorkspace = async (
  sandbox: SpritesProviderSandbox,
): Promise<void> => {
  const result = await sandbox.exec({
    command: `mkdir -p ${WORKSPACE}`,
    workingDirectory: SPRITE_HOME,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `sprites: could not create ${WORKSPACE}: ${result.stderr.trim()}`,
    );
  }
};

/**
 * Makes a sprite; on any failure, deletes it. Until the handle exists, a
 * host that exits deletes the sprite too; after that, `close()` (or a
 * cleanup sweep) does, so a detached run outlives the host.
 */
export const createSprite = async (
  client: SpritesClient,
  create: SpritesCreateOptions | undefined,
  options: ProviderCreateOptions,
): Promise<SpritesProviderSandbox> => {
  const { name, killTime } = newSpriteName(options.timeLimitMinutes);
  const unregister = registerSpriteDeletion(client.baseURL, client.token, name);
  try {
    const { config, ...rest } = create ?? {};
    const sprite = await client.createSprite(name, config, rest);
    options.abortSignal?.throwIfAborted();
    const sandbox = openSandbox(client, sprite, { killTime, env: options.env });
    await makeWorkspace(sandbox);
    return sandbox;
  } catch (error) {
    await deleteSprite(client, name).catch(() => undefined);
    throw error;
  } finally {
    unregister();
  }
};

/**
 * An existing sprite by name, or `undefined` once it's gone. Its kill time
 * comes from its name, so the sprite isn't woken. Its commands get only
 * their own env: `reattachSandbox` takes the sandbox's env again.
 */
export const getSprite = async (
  client: SpritesClient,
  name: string,
): Promise<SpritesProviderSandbox | undefined> => {
  const parsed = parseSpriteName(name);
  if (parsed === undefined) {
    throw new TypeError(
      `sprites: "${name}" is not the name of a sprite Sandcastle made`,
    );
  }
  const sprite = await client.getSprite(name).catch((error: unknown) => {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  });
  return sprite === undefined
    ? undefined
    : openSandbox(client, sprite, { killTime: parsed.killTime, env: {} });
};

/** Starts work in a sprite that outlives the host's hold on it. */
export const spawnInSpritesSandbox = async (
  sandbox: SpritesProviderSandbox,
  options: {
    readonly command: string;
    readonly workingDirectory?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  const context = contexts.get(sandbox);
  if (context === undefined) {
    throw new TypeError(`sprites: ${sandbox.sandboxId} is not open`);
  }
  await spawnInSprite(context, context.killTime, options);
};
