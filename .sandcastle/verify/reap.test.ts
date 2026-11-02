import { describe, expect, it } from "vitest";
import { parseReapArgs, reap } from "./reap.ts";
import type { AliveSandbox, RemoteAccount, RemoteProvider } from "./reap.ts";

/** A fake account holding `alive`; records what it was asked to remove. */
const account = (
  provider: RemoteProvider,
  alive: AliveSandbox[],
  opts: { missing?: string[]; failList?: string; failRemove?: string } = {},
) => {
  const removed: string[] = [];
  const fake: RemoteAccount = {
    provider,
    missing: () => opts.missing ?? [],
    list: async () => {
      if (opts.failList !== undefined) {
        throw new Error(opts.failList);
      }
      return alive;
    },
    remove: async (id) => {
      if (id === opts.failRemove) {
        throw new Error("boom");
      }
      removed.push(id);
    },
  };
  return { fake, removed };
};

const sandbox = (id: string, ours: boolean): AliveSandbox => ({
  id,
  state: "running",
  ours,
});

describe("reap", () => {
  it("reports zero alive and exits 0 when every account is empty", async () => {
    const result = await reap([account("e2b", []).fake], parseReapArgs([]));
    expect(result).toStrictEqual({
      code: 0,
      lines: ["  e2b      0 alive"],
    });
  });

  it("skips a provider whose key is missing, naming the key", async () => {
    const result = await reap(
      [account("modal", [], { missing: ["MODAL_TOKEN_ID"] }).fake],
      parseReapArgs([]),
    );
    expect(result.lines).toStrictEqual([
      "  modal    skipped (missing MODAL_TOKEN_ID)",
    ]);
    expect(result.code).toBe(0);
  });

  it("lists alive sandboxes without removing them, and exits 1", async () => {
    const sprites = account("sprites", [
      sandbox("sandcastle-1", true),
      sandbox("mine", false),
    ]);
    const result = await reap([sprites.fake], parseReapArgs([]));
    expect(sprites.removed).toStrictEqual([]);
    expect(result).toStrictEqual({
      code: 1,
      lines: [
        "  sprites  2 alive",
        "    sandcastle-1 (running), Sandcastle's",
        "    mine (running), not known to be Sandcastle's: pass sprites:mine to delete it",
      ],
    });
  });

  it("with --delete, removes only Sandcastle's sandboxes", async () => {
    const sprites = account("sprites", [
      sandbox("sandcastle-1", true),
      sandbox("mine", false),
    ]);
    const result = await reap([sprites.fake], parseReapArgs(["--delete"]));
    expect(sprites.removed).toStrictEqual(["sandcastle-1"]);
    expect(result.lines).toContain("    sandcastle-1 (running), deleted");
    expect(result.code).toBe(1);
  });

  it("with --delete and a named id, removes that sandbox too", async () => {
    const e2b = account("e2b", [sandbox("abc", false), sandbox("def", false)]);
    const result = await reap(
      [e2b.fake],
      parseReapArgs(["--delete", "e2b:abc"]),
    );
    expect(e2b.removed).toStrictEqual(["abc"]);
    expect(result.lines).toContain("    abc (running), deleted");
  });

  it("exits 0 after deleting everything that was alive", async () => {
    const modal = account("modal", [sandbox("sb-1", true)]);
    const result = await reap([modal.fake], parseReapArgs(["--delete"]));
    expect(result.code).toBe(0);
  });

  it("reports a named id that is not alive", async () => {
    const result = await reap(
      [account("e2b", []).fake],
      parseReapArgs(["e2b:gone"]),
    );
    expect(result.lines).toStrictEqual([
      "  e2b      0 alive",
      "    gone: named, but not alive",
    ]);
  });

  it("reports a listing or delete failure and exits 1", async () => {
    const broken = account("vercel", [], { failList: "401 Unauthorized" });
    const stuck = account("daytona", [sandbox("d1", true)], {
      failRemove: "d1",
    });
    const result = await reap(
      [broken.fake, stuck.fake],
      parseReapArgs(["--delete"]),
    );
    expect(result).toStrictEqual({
      code: 1,
      lines: [
        "  vercel   ERROR listing: 401 Unauthorized",
        "  daytona  1 alive",
        "    d1 (running), Sandcastle's, FAILED to delete: boom",
      ],
    });
  });
});

describe("parseReapArgs", () => {
  it("rejects an id without a known provider", () => {
    expect(() => parseReapArgs(["fly:abc"])).toThrow(
      "reap: name a sandbox as <provider>:<id>, provider one of vercel, daytona, e2b, modal, sprites",
    );
  });
});
