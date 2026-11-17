import { randomUUID } from "node:crypto";
import { DateTime } from "effect";

// The names Sandcastle gives sprites. Sprites have no time limit of their
// own, so a sprite's kill time lives in its name: anything that lists
// sprites (a cleanup sweep, `get`) reads it back without waking the sprite.

/** The prefix of every sprite name Sandcastle makes: list sprites by it to find Sandcastle's. */
export const SPRITE_NAME_PREFIX = "sandcastle-";

const NAME =
  /^sandcastle-(?<seconds>\d{1,12})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The time `seconds` after the epoch. */
const dateAt = (seconds: number): Date =>
  DateTime.toDateUtc(DateTime.unsafeMake(seconds * 1000));

/** What a sprite name Sandcastle made says about its sprite. */
export interface SpriteName {
  /** When the sprite's time limit runs out: Sandcastle's kill time for it, to the second. */
  readonly killTime: Date;
}

/**
 * Reads a sprite name Sandcastle made, `sandcastle-<kill time in epoch
 * seconds>-<uuid>`, or gives `undefined` for any other name (a sprite
 * Sandcastle didn't make, or one an earlier Sandcastle named without a kill
 * time).
 *
 * @example
 * ```ts
 * parseSpriteName("sandcastle-1794931200-0b9d5c7e-3f1a-4c2e-9d8b-6a5f4e3d2c1b");
 * // { killTime: 2026-11-17T16:00:00.000Z }
 * ```
 */
export const parseSpriteName = (name: string): SpriteName | undefined => {
  const seconds = NAME.exec(name)?.groups?.seconds;
  return seconds === undefined
    ? undefined
    : { killTime: dateAt(Number(seconds)) };
};

/** A fresh sprite name for a sprite that ends `timeLimitMinutes` from now, and that kill time. */
export const newSpriteName = (
  timeLimitMinutes: number,
): { readonly name: string; readonly killTime: Date } => {
  const nowMs = DateTime.unsafeNow().epochMillis;
  const seconds = Math.floor((nowMs + timeLimitMinutes * 60_000) / 1000);
  return {
    name: `${SPRITE_NAME_PREFIX}${seconds}-${randomUUID()}`,
    killTime: dateAt(seconds),
  };
};
