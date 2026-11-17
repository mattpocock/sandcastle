// sweepSprites(), the host-side cleanup of Sandcastle sprites nobody closed.
// Its entry point is ./sprites.ts.

import type { SpritesClient } from "@fly/sprites";
import { DateTime } from "effect";
import { parseSpriteName, SPRITE_NAME_PREFIX } from "./spritesName.js";
import { isNotFound } from "./spritesSandbox.js";
import { spritesToken } from "./spritesToken.js";

/** Options for `sweepSprites()`. */
export interface SweepSpritesOptions {
  /** Sprites API token. Default the `SPRITES_TOKEN` environment variable, then `SPRITE_TOKEN`. It stays on the host. */
  readonly token?: string;
  /** The time to sweep at. Default now. */
  readonly now?: Date;
  /** How long past its kill time a sprite is left, so a run reporting at its deadline isn't cut off. Default 15. */
  readonly graceMinutes?: number;
  /** When true, delete nothing: `closed` lists what the sweep would delete. Default false. */
  readonly dryRun?: boolean;
}

/** What `sweepSprites()` did, by sprite name. */
export interface SweepSpritesResult {
  /** Sandcastle's sprites whose kill time and grace had passed, now deleted (or, on a dry run, to delete). One already gone counts. */
  readonly closed: readonly string[];
  /** Sandcastle's sprites still inside their time limit or grace, left alone. */
  readonly kept: readonly string[];
  /** Sprites named with Sandcastle's prefix whose kill time can't be read from the name (an earlier Sandcastle's, or renamed), left alone. */
  readonly skipped: readonly string[];
}

const DEFAULT_GRACE_MINUTES = 15;

/** Every sprite name in the account that starts with Sandcastle's prefix, from the page at `continuationToken` on. */
const listNames = async (
  client: SpritesClient,
  continuationToken?: string,
): Promise<string[]> => {
  const page = await client.listSprites({
    prefix: SPRITE_NAME_PREFIX,
    continuationToken,
  });
  const names = page.sprites.map((sprite) => sprite.name);
  const next = page.hasMore ? page.nextContinuationToken : undefined;
  return next === undefined
    ? names
    : [...names, ...(await listNames(client, next))];
};

/** Sorts names into expired, unexpired and unreadable at `cutoff` (now minus the grace). */
const triage = (names: readonly string[], cutoffMs: number) => {
  const expired: string[] = [];
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const killTime = parseSpriteName(name)?.killTime;
    if (killTime === undefined) {
      skipped.push(name);
    } else if (killTime.getTime() < cutoffMs) {
      expired.push(name);
    } else {
      kept.push(name);
    }
  }
  return { expired, kept, skipped };
};

/** Deletes a sprite, one already gone counting as deleted; resolves with the error if the delete failed. */
const deleteOne = async (
  client: SpritesClient,
  name: string,
): Promise<unknown> =>
  client.deleteSprite(name).then(
    () => undefined,
    (error: unknown) => (isNotFound(error) ? undefined : error),
  );

/**
 * Deletes each sprite in turn, so a big sweep doesn't trip the API's rate
 * limit. Rejects naming those that failed, once every delete has been tried.
 */
const deleteAll = async (
  client: SpritesClient,
  names: readonly string[],
): Promise<void> => {
  const failures = await names.reduce<Promise<[string, unknown][]>>(
    async (earlier, name) => {
      const failed = await earlier;
      const error = await deleteOne(client, name);
      return error === undefined ? failed : [...failed, [name, error]];
    },
    Promise.resolve([]),
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(([, error]) => error),
      `sweepSprites(): couldn't delete ${failures.map(([name]) => name).join(", ")}. The rest of the sweep ran; run it again to retry.`,
    );
  }
};

const graceOf = (graceMinutes: number | undefined): number => {
  const grace = graceMinutes ?? DEFAULT_GRACE_MINUTES;
  if (!Number.isFinite(grace) || grace < 0) {
    throw new RangeError(
      `sweepSprites(): graceMinutes must be 0 or more, not ${String(grace)}.`,
    );
  }
  return grace;
};

/**
 * Deletes the sprites Sandcastle made whose time ran out and nobody closed,
 * for example after the host or orchestrator crashed. Sprites have no time
 * limit of their own, so such a sprite stays, holding its storage, until
 * something deletes it: run this on a schedule.
 *
 * It lists the account's sprites named with `SPRITE_NAME_PREFIX`, reads each
 * one's kill time from its name, and deletes those whose kill time plus
 * `graceMinutes` has passed. It never touches a sprite named any other way,
 * or one whose name it can't read (an earlier Sandcastle's
 * `sandcastle-<uuid>`): those are `skipped`. It only lists and deletes, so it
 * never wakes a paused sprite. A sprite already gone counts as closed, so two
 * sweeps at once are safe. The token stays on the host.
 *
 * @example
 * ```ts
 * import { sweepSprites } from "@ai-hero/sandcastle/v1/sandboxes/sprites";
 *
 * // From a scheduled job, every hour or so:
 * const { closed, kept, skipped } = await sweepSprites();
 * console.log(`closed ${closed.length}, kept ${kept.length}, skipped ${skipped.length}`);
 * ```
 */
export const sweepSprites = async (
  options: SweepSpritesOptions = {},
): Promise<SweepSpritesResult> => {
  const grace = graceOf(options.graceMinutes);
  const nowMs = options.now?.getTime() ?? DateTime.unsafeNow().epochMillis;
  const token = await spritesToken(options.token, "sweepSprites()");
  const { SpritesClient: Client } = await import("@fly/sprites");
  const client = new Client(token);
  const { expired, kept, skipped } = triage(
    await listNames(client),
    nowMs - grace * 60_000,
  );
  if (options.dryRun !== true) {
    await deleteAll(client, expired);
  }
  return { closed: expired, kept, skipped };
};
