// sprites(), the Fly.io Sprites provider. Its entry point is ./sprites.ts.

import type { Sprite, SpritesClient } from "@fly/sprites";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { SpritesCreateOptions } from "./spritesSandbox.js";
import { spritesToken } from "./spritesToken.js";
import {
  createSprite,
  getSprite,
  spawnInSpritesSandbox,
} from "./spritesSandbox.js";

/** Options for `sprites()`. They stay on the host: none reach the sandbox. */
export interface SpritesOptions {
  /** Sprites API token. Default the `SPRITES_TOKEN` environment variable, then `SPRITE_TOKEN` (the Sprites CLI's name). */
  readonly token?: string;
  /** Passed to `@fly/sprites`' create: the sprite's `config` (size, region), `labels`, and anything else it takes. */
  readonly create?: SpritesCreateOptions;
}

/**
 * A provider of Fly.io Sprites. Each sandbox is a new sprite named
 * `sandcastle-<kill time in epoch seconds>-<uuid>`. Sprites have no time
 * limit of their own, so the kill time is now plus `timeLimitMinutes`, which
 * the session supervisor's deadline enforces. Env reaches each command
 * through a file that is removed as the command starts, never through the
 * exec URL. `close()` deletes the sprite. Its sandboxes are detachable: the
 * session supervisor runs in an exec that carries on after the host
 * disconnects, and holds a Task so the sprite isn't paused while it works.
 * `native` is `@fly/sprites`' `Sprite`.
 *
 * Needs `@fly/sprites` installed beside Sandcastle (it asks for Node 24 or
 * later on the host).
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { sprites } from "@ai-hero/sandcastle/v1/sandboxes/sprites";
 *
 * await using sandbox = await createSandbox({
 *   provider: sprites({ create: { labels: ["nightly"] } }),
 *   env: { GH_TOKEN: token },
 *   timeLimitMinutes: 60,
 * });
 * ```
 */
export const sprites = (
  options: SpritesOptions = {},
): SandboxProvider<Sprite, true> => {
  let client: Promise<SpritesClient> | undefined;
  const connect = async (): Promise<SpritesClient> => {
    client ??= spritesToken(options.token, "sprites()")
      .then(async (token) =>
        import("@fly/sprites").then(
          ({ SpritesClient: Client }) => new Client(token),
        ),
      )
      .catch((error: unknown) => {
        // A later call may try again, once the token is set.
        client = undefined;
        throw error;
      });
    return client;
  };
  return createSandboxProvider({
    name: "sprites",
    create: async (createOptions) =>
      createSprite(await connect(), options.create, createOptions),
    detach: {
      spawnDetached: spawnInSpritesSandbox,
      get: async (name) => getSprite(await connect(), name),
    },
  });
};
