import { Config, Effect } from "effect";

// The Sprites API token, for sprites() and sweepSprites(). It stays on the
// host: nothing here reaches a sandbox.

/** An option or env var counts as unset when it is missing or empty. */
const setOrUndefined = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

/** `SPRITES_TOKEN` then `SPRITE_TOKEN` from the environment, "" when unset. */
const envTokens = Effect.all([
  Config.string("SPRITES_TOKEN").pipe(Config.withDefault("")),
  Config.string("SPRITE_TOKEN").pipe(Config.withDefault("")),
]);

/** The token: `token`, then `SPRITES_TOKEN`, then `SPRITE_TOKEN`. `caller` names the function in the error when there's none. */
export const spritesToken = async (
  token: string | undefined,
  caller: string,
): Promise<string> => {
  const [plural, singular] = await Effect.runPromise(envTokens);
  const found =
    setOrUndefined(token) ?? setOrUndefined(plural) ?? setOrUndefined(singular);
  if (found === undefined) {
    throw new Error(
      `${caller}: no Sprites token. Set SPRITES_TOKEN (or SPRITE_TOKEN), or pass the token option.`,
    );
  }
  return found;
};
