/**
 * Whose artefact is it? Several worlds (and `npm test` runs) share one
 * machine, so the ledger only blames a world for what it can tie to that
 * world. Pure, so the judgement is unit-tested (attribution.test.ts).
 */

/** A world's run id, as `createWorld` makes it: <yyyymmdd>-<hhmmss>-<4hex>. */
export const RUN_ID = /\d{8}-\d{6}-[0-9a-f]{4}/g;

export const runIdsIn = (text: string): string[] => [
  ...new Set(text.match(RUN_ID) ?? []),
];

export interface WorldSpan {
  readonly runId: string;
  readonly createdAt: string;
  readonly cleanedAt?: string;
}

export interface ImageAttribution {
  /**
   * own: named with this world's run id (cleanup removes it).
   * other-world: named with another world's run id; never this world's leak.
   * leak: an unnamed `sandcastle:` image built during this world's life, when
   *   no other world was live.
   * ambiguous: as `leak`, but another world was live too, so it can't be
   *   pinned on this one.
   * unrelated: not a Sandcastle image, or built before this world.
   */
  readonly kind: "own" | "other-world" | "leak" | "ambiguous" | "unrelated";
  readonly detail: string;
}

/** Docker prints RFC 3339; podman prints Go's `2006-01-02 15:04:05.999 -0700 MST`. */
export const parseEngineTime = (raw: string): number | undefined => {
  const m =
    /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(
      raw.trim(),
    );
  if (!m) {
    return undefined;
  }
  const frac = m[3] ? m[3].slice(0, 4) : "";
  let zone = m[4] ?? "Z";
  if (/^[+-]\d{4}$/.test(zone)) {
    zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  const t = Date.parse(`${m[1]}T${m[2]}${frac}${zone}`);
  return Number.isNaN(t) ? undefined : t;
};

const liveAt = (w: WorldSpan, t: number, now: number): boolean =>
  Date.parse(w.createdAt) <= t &&
  t <= (w.cleanedAt === undefined ? now : Date.parse(w.cleanedAt));

/**
 * Attribute an image that is new since `self` was created. `others` are the
 * other worlds on this machine (from any checkout), cleaned up or not.
 */
export const attributeImage = (
  image: { readonly ref: string; readonly created?: string },
  self: WorldSpan,
  others: readonly WorldSpan[],
  now: string,
): ImageAttribution => {
  const ids = runIdsIn(image.ref);
  if (ids.includes(self.runId)) {
    return { kind: "own", detail: "this world's, cleanup removes it" };
  }
  if (ids.length > 0) {
    return {
      kind: "other-world",
      detail: `named for world ${ids.join(", ")}, not this one`,
    };
  }
  if (!/^(localhost\/)?sandcastle:/.test(image.ref)) {
    return {
      kind: "unrelated",
      detail: "new since the world began, not a Sandcastle image",
    };
  }
  const nowT = Date.parse(now);
  const t =
    image.created === undefined ? undefined : parseEngineTime(image.created);
  if (t !== undefined && t < Date.parse(self.createdAt)) {
    return {
      kind: "unrelated",
      detail: "built before this world (newly tagged since)",
    };
  }
  // Unknown build time: assume it was built now, i.e. during the world.
  const at = t ?? nowT;
  const rivals = others
    .filter((w) => w.runId !== self.runId && liveAt(w, at, nowT))
    .map((w) => w.runId);
  if (rivals.length > 0) {
    return {
      kind: "ambiguous",
      detail: `built outside any run-id name while world ${rivals.join(", ")} was also live, so not pinned on this one`,
    };
  }
  return {
    kind: "leak",
    detail: "built during this world's life, outside its run-id name",
  };
};

/**
 * A shared-$TMPDIR entry is this world's only when its name, or a sample of
 * its content, names the world. (The world's own verbs write their temp
 * entries to <world>/tmp, which the ledger checks wholesale.)
 */
export const sharedTmpEntryIsWorlds = (
  name: string,
  contents: readonly string[],
  world: { readonly runId: string; readonly dir: string },
): boolean =>
  name.includes(world.runId) ||
  contents.some((c) => c.includes(world.runId) || c.includes(world.dir));

/** The next `LEDGER-<n>.md` in a world dir; earlier ledgers are never overwritten. */
export const ledgerFileName = (existing: readonly string[]): string => {
  const ns = existing
    .map((f) => /^LEDGER-(\d+)\.md$/.exec(f)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
  return `LEDGER-${ns.length > 0 ? Math.max(...ns) + 1 : 1}.md`;
};
