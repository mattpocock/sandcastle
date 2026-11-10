/**
 * Fly.io Sprites isolated sandbox provider — wraps `@fly/sprites` into a
 * SandboxProvider.
 *
 * Usage:
 *   import { sprites } from "@ai-hero/sandcastle/sandboxes/sprites";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: sprites() });
 */

import { runPromise } from "../runPromise.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { Config, Effect } from "effect";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  ExecResult,
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { execInSprite } from "./spritesExec.js";
import { registerSpriteDeletion } from "./spritesShutdown.js";
import type { Sprite } from "@fly/sprites";

/** The Sprite user's home: the worktree's parent, which the user can write. */
const SPRITE_HOME = "/home/sprite";

/** Worktree path inside the Sprite. */
const SPRITES_REPO_PATH = posix.join(SPRITE_HOME, "workspace");

/** Options for the Fly.io Sprites sandbox provider. */
export interface SpritesOptions {
  /**
   * Sprites API token.
   *
   * Falls back to the `SPRITES_TOKEN` environment variable, then to
   * `SPRITE_TOKEN` (the name the Sprites CLI uses).
   */
  readonly token?: string;

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

/** An option or env var counts as unset when it is missing or empty. */
const setOrUndefined = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

/** `SPRITES_TOKEN` then `SPRITE_TOKEN` from the environment, "" when unset. */
const envTokens = Effect.all([
  Config.string("SPRITES_TOKEN").pipe(Config.withDefault("")),
  Config.string("SPRITE_TOKEN").pipe(Config.withDefault("")),
]);

/** The token: the option, then `SPRITES_TOKEN`, then `SPRITE_TOKEN`. */
const resolveToken = async (
  options: SpritesOptions | undefined,
): Promise<string> => {
  const [plural, singular] = await runPromise(envTokens);
  const token =
    setOrUndefined(options?.token) ??
    setOrUndefined(plural) ??
    setOrUndefined(singular);
  if (token === undefined) {
    throw new Error(
      "sprites(): no Sprites token. Set SPRITES_TOKEN (or SPRITE_TOKEN), or pass the token option.",
    );
  }
  return token;
};

/** Copy a host file, or every file under a host directory, into the Sprite. */
const copyIntoSprite = async (
  sprite: Sprite,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const fs = sprite.filesystem();
  const info = await stat(hostPath);
  if (!info.isDirectory()) {
    await fs.writeFile(sandboxPath, await readFile(hostPath));
    return;
  }
  const entries = await readdir(hostPath, {
    withFileTypes: true,
    recursive: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  // `writeFile` creates the parent folders in the Sprite.
  await Promise.all(
    files.map(async (file) => {
      const parts = relative(hostPath, file).split(/[\\/]/u);
      await fs.writeFile(
        posix.join(sandboxPath, ...parts),
        await readFile(file),
      );
    }),
  );
};

/** What a handle needs beyond its Sprite. */
interface HandleContext {
  readonly env: Record<string, string>;
  readonly maxOutputTailChars: number;
  readonly unregisterShutdown: () => void;
}

/** The Sandcastle handle over a Sprite whose worktree folder exists. */
const makeHandle = (
  sprite: Sprite,
  { env, maxOutputTailChars, unregisterShutdown }: HandleContext,
): IsolatedSandboxHandle => ({
  worktreePath: SPRITES_REPO_PATH,
  // A Sprite is addressed by its name in the Sprites API and CLI.
  sandboxId: sprite.name,

  exec: async (command, opts): Promise<ExecResult> =>
    execInSprite(sprite, {
      ...opts,
      command,
      cwd: opts?.cwd ?? SPRITES_REPO_PATH,
      env,
      maxOutputTailChars,
    }),

  copyIn: async (hostPath, sandboxPath): Promise<void> =>
    copyIntoSprite(sprite, hostPath, sandboxPath),

  copyFileOut: async (sandboxPath, hostPath): Promise<void> => {
    const buffer = await sprite.filesystem().readFile(sandboxPath, null);
    await mkdir(dirname(hostPath), { recursive: true });
    await writeFile(hostPath, buffer);
  },

  close: async (): Promise<void> => {
    await sprite.delete();
    // Only once the delete has gone through: if it threw, the exit teardown
    // tries again.
    unregisterShutdown();
  },
});

/** Create the worktree folder as the Sprite user, so sync-in can replace it. */
const makeWorktreeDir = async (sprite: Sprite): Promise<void> => {
  const result = await execInSprite(sprite, {
    command: `mkdir -p ${SPRITES_REPO_PATH}`,
    cwd: SPRITE_HOME,
    env: {},
    maxOutputTailChars: MAX_TAIL_CHARS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `sprites(): could not create ${SPRITES_REPO_PATH}: ${result.stderr.trim()}`,
    );
  }
};

/**
 * Create a Fly.io Sprites isolated sandbox provider.
 *
 * Each `create()` makes a new Sprite, and `close()` deletes it. Sprites
 * persist until deleted, so Sandcastle also deletes the Sprite when setup
 * fails, and when the process is interrupted or exits without closing it.
 * The default Sprite image ships `git`, Node and the `claude` CLI; install
 * other agent CLIs in an `onSandboxReady` hook.
 *
 * Requires `@fly/sprites` to be installed as a peer dependency (it asks for
 * Node 24 or later).
 *
 * @example
 * ```ts
 * import { sprites } from "@ai-hero/sandcastle/sandboxes/sprites";
 *
 * const provider = sprites({ env: { MY_VAR: "value" } });
 * ```
 */
export const sprites = (options?: SpritesOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "sprites",
    env: options?.env,
    create: async ({ env }): Promise<IsolatedSandboxHandle> => {
      const token = await resolveToken(options);
      // Dynamic import so the peer dependency is only loaded at runtime
      const { SpritesClient } = await import("@fly/sprites");
      const client = new SpritesClient(token);
      const name = `sandcastle-${randomUUID()}`;
      // Registered before the create request, so an interrupt while it is in
      // flight still deletes the Sprite (deleting a missing name is a no-op).
      const unregisterShutdown = registerSpriteDeletion(
        client.baseURL,
        token,
        name,
      );
      try {
        const sprite = await client.createSprite(name);
        await makeWorktreeDir(sprite);
        return makeHandle(sprite, {
          env,
          maxOutputTailChars: options?.maxOutputTailChars ?? MAX_TAIL_CHARS,
          unregisterShutdown,
        });
      } catch (error) {
        // No handle exists yet, so neither Sandcastle's teardown nor
        // `close()` can reach the Sprite, and it would persist.
        await client.deleteSprite(name).catch(() => undefined);
        unregisterShutdown();
        throw error;
      }
    },
  });
