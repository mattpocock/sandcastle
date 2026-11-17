import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepSprites } from "@ai-hero/sandcastle/v1/sandboxes/sprites";
import {
  addFakeSprites,
  destroyAllFakeSprites,
  fakeSprites,
  resetFakeSprites,
  standingSprites,
} from "./helpers/fakeSprites.js";

// sweepSprites() through its subpath, with `@fly/sprites` module-mocked by
// the same fake as sprites()' suite. The sweep only lists and deletes, so
// these sprites are names in the fake account: nothing runs in them.

vi.mock("@fly/sprites", async () => {
  const { FakeSpritesClient } = await import("./helpers/fakeSprites.js");
  return { SpritesClient: FakeSpritesClient };
});

const TOKEN = "sprites-test-token";

/** The time the tests sweep at. */
const NOW = new Date("2026-11-17T12:00:00.000Z");

/** A name Sandcastle would give a sprite whose kill time is `minutes` from NOW. */
const tagged = (minutes: number): string =>
  `sandcastle-${Math.floor(NOW.getTime() / 1000) + minutes * 60}-${randomUUID()}`;

describe("sweepSprites() (v1)", () => {
  beforeEach(async () => {
    await resetFakeSprites();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await destroyAllFakeSprites();
  });

  it("deletes a Sandcastle sprite whose kill time and grace have passed", async () => {
    const expired = tagged(-16);
    await addFakeSprites(expired);

    const result = await sweepSprites({ token: TOKEN, now: NOW });

    expect(result).toStrictEqual({ closed: [expired], kept: [], skipped: [] });
    expect(standingSprites()).toStrictEqual([]);
  });

  it("keeps a Sandcastle sprite inside its time limit or its grace", async () => {
    const live = tagged(30);
    const inGrace = tagged(-14);
    await addFakeSprites(live, inGrace);

    const result = await sweepSprites({ token: TOKEN, now: NOW });

    expect(result.closed).toStrictEqual([]);
    expect(result.kept).toStrictEqual([live, inGrace]);
    expect(standingSprites()).toHaveLength(2);
  });

  it("takes the grace from graceMinutes, and rejects a negative one", async () => {
    const expired = tagged(-5);
    await addFakeSprites(expired);

    await expect(
      sweepSprites({ token: TOKEN, now: NOW, graceMinutes: -1 }),
    ).rejects.toThrow(RangeError);
    const result = await sweepSprites({
      token: TOKEN,
      now: NOW,
      graceMinutes: 0,
    });

    expect(result.closed).toStrictEqual([expired]);
  });

  it("leaves alone a sprite Sandcastle didn't name, and one whose name it can't read", async () => {
    const other = `nightly-${randomUUID()}`;
    const earlier = `sandcastle-${randomUUID()}`;
    const malformed = "sandcastle-12-not-a-uuid";
    await addFakeSprites(other, earlier, malformed);

    const result = await sweepSprites({ token: TOKEN, now: NOW });

    expect(result.closed).toStrictEqual([]);
    expect(result.kept).toStrictEqual([]);
    expect(result.skipped).toStrictEqual([earlier, malformed]);
    expect(standingSprites()).toHaveLength(3);
    expect(fakeSprites.lists.map((list) => list.prefix)).toStrictEqual([
      "sandcastle-",
    ]);
  });

  it("counts a sprite already gone as closed", async () => {
    const ghost = tagged(-60);
    fakeSprites.ghosts.push(ghost);

    const result = await sweepSprites({ token: TOKEN, now: NOW });

    expect(result.closed).toStrictEqual([ghost]);
  });

  it("deletes nothing on a dry run, and reports what it would close", async () => {
    const expired = tagged(-60);
    const live = tagged(60);
    await addFakeSprites(expired, live);

    const result = await sweepSprites({ token: TOKEN, now: NOW, dryRun: true });

    expect(result).toStrictEqual({
      closed: [expired],
      kept: [live],
      skipped: [],
    });
    expect(fakeSprites.deleted).toStrictEqual([]);
    expect(standingSprites()).toHaveLength(2);
  });

  it("sweeps every page of the list", async () => {
    fakeSprites.pageSize = 2;
    const expired = [-90, -80, -70, -60, -50].map((minutes) => tagged(minutes));
    await addFakeSprites(...expired);

    const result = await sweepSprites({ token: TOKEN, now: NOW });

    expect(result.closed).toHaveLength(5);
    expect(fakeSprites.lists.map((list) => list.from)).toStrictEqual([
      undefined,
      "2",
      "4",
    ]);
    expect(standingSprites()).toStrictEqual([]);
  });

  it("never runs a command, opens a file or wakes a sprite", async () => {
    await addFakeSprites(tagged(-60), tagged(60), `sandcastle-${randomUUID()}`);

    await sweepSprites({ token: TOKEN, now: NOW });

    expect(fakeSprites.spawns).toStrictEqual([]);
    expect(fakeSprites.writes).toStrictEqual([]);
    expect(fakeSprites.filesystemOpens).toBe(0);
    expect(fakeSprites.gets).toStrictEqual([]);
  });

  it("tries every delete, then rejects naming the ones that failed", async () => {
    const stuck = tagged(-60);
    const expired = tagged(-50);
    await addFakeSprites(stuck, expired);
    fakeSprites.deleteFails = new RegExp(stuck, "u");

    await expect(sweepSprites({ token: TOKEN, now: NOW })).rejects.toThrow(
      stuck,
    );
    expect(standingSprites()).toStrictEqual([stuck]);
  });

  it("reads the token from SPRITES_TOKEN, then SPRITE_TOKEN, and fails without one", async () => {
    vi.stubEnv("SPRITES_TOKEN", "");
    vi.stubEnv("SPRITE_TOKEN", "from-the-cli-name");
    await sweepSprites({ now: NOW });
    vi.stubEnv("SPRITES_TOKEN", "from-the-plural");
    await sweepSprites({ now: NOW });
    vi.stubEnv("SPRITES_TOKEN", "");
    vi.stubEnv("SPRITE_TOKEN", "");

    expect(fakeSprites.tokens).toStrictEqual([
      "from-the-cli-name",
      "from-the-plural",
    ]);
    await expect(sweepSprites({ now: NOW })).rejects.toThrow(/SPRITES_TOKEN/u);
  });

  it("sweeps at the current time by default", async () => {
    const longGone = `sandcastle-${Math.floor(Date.now() / 1000) - 3600}-${randomUUID()}`;
    const live = `sandcastle-${Math.floor(Date.now() / 1000) + 3600}-${randomUUID()}`;
    await addFakeSprites(longGone, live);

    const result = await sweepSprites({ token: TOKEN });

    expect(result).toStrictEqual({
      closed: [longGone],
      kept: [live],
      skipped: [],
    });
  });
});
