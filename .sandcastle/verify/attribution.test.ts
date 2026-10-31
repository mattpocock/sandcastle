import { describe, expect, it } from "vitest";
import {
  attributeImage,
  ledgerFileName,
  parseEngineTime,
  runIdsIn,
  sharedTmpEntryIsWorlds,
} from "./attribution.ts";

const self = {
  runId: "20261030-210000-aaaa",
  createdAt: "2026-10-30T21:00:00.000Z",
};
const sibling = {
  runId: "20261030-210500-bbbb",
  createdAt: "2026-10-30T21:05:00.000Z",
};
const now = "2026-10-30T22:00:00.000Z";

describe("runIdsIn", () => {
  it("finds every run id in an image ref", () => {
    expect(runIdsIn("sandcastle:world-20261030-210500-bbbb")).toEqual([
      "20261030-210500-bbbb",
    ]);
    expect(runIdsIn("sandcastle:local")).toEqual([]);
  });
});

describe("attributeImage", () => {
  it("claims an image named with this world's run id", () => {
    const a = attributeImage(
      { ref: "sandcastle:world-20261030-210000-aaaa" },
      self,
      [sibling],
      now,
    );
    expect(a.kind).toBe("own");
  });

  it("never claims an image named with another world's run id", () => {
    const a = attributeImage(
      {
        ref: "sandcastle:world-20261030-210500-bbbb",
        created: "2026-10-30T21:10:00.000Z",
      },
      self,
      [],
      now,
    );
    expect(a.kind).toBe("other-world");
    expect(a.detail).toContain("20261030-210500-bbbb");
  });

  it("leaks an unnamed sandcastle image built in this world's lifetime when no other world was live", () => {
    const a = attributeImage(
      { ref: "sandcastle:custom", created: "2026-10-30T21:30:00.000Z" },
      self,
      [],
      now,
    );
    expect(a.kind).toBe("leak");
  });

  it("does not claim an unnamed sandcastle image built while another world was live", () => {
    const a = attributeImage(
      { ref: "sandcastle:custom", created: "2026-10-30T21:30:00.000Z" },
      self,
      [sibling],
      now,
    );
    expect(a.kind).toBe("ambiguous");
    expect(a.detail).toContain("20261030-210500-bbbb");
  });

  it("ignores a world that was already cleaned up when the image was built", () => {
    const a = attributeImage(
      { ref: "sandcastle:custom", created: "2026-10-30T21:30:00.000Z" },
      self,
      [{ ...sibling, cleanedAt: "2026-10-30T21:20:00.000Z" }],
      now,
    );
    expect(a.kind).toBe("leak");
  });

  it("does not claim an unnamed sandcastle image built before the world", () => {
    const a = attributeImage(
      { ref: "sandcastle:custom", created: "2026-10-30T20:00:00.000Z" },
      self,
      [],
      now,
    );
    expect(a.kind).toBe("unrelated");
  });

  it("leaks an unnamed sandcastle image whose build time is unknown, when alone", () => {
    expect(
      attributeImage({ ref: "localhost/sandcastle:x" }, self, [], now).kind,
    ).toBe("leak");
  });

  it("does not attribute a non-sandcastle image", () => {
    expect(
      attributeImage(
        { ref: "node:22", created: "2026-10-30T21:30:00.000Z" },
        self,
        [],
        now,
      ).kind,
    ).toBe("unrelated");
  });
});

describe("parseEngineTime", () => {
  it("reads docker's RFC 3339 and podman's Go time format", () => {
    expect(parseEngineTime("2026-10-30T21:30:00.123456789Z")).toBe(
      Date.parse("2026-10-30T21:30:00.123Z"),
    );
    expect(parseEngineTime("2026-10-30 21:30:00.123456789 +0000 UTC")).toBe(
      Date.parse("2026-10-30T21:30:00.123Z"),
    );
    expect(parseEngineTime("garbage")).toBeUndefined();
  });
});

describe("ledgerFileName", () => {
  it("never reuses an existing ledger's name", () => {
    expect(ledgerFileName([])).toBe("LEDGER-1.md");
    expect(ledgerFileName(["LEDGER-1.md", "logs", "LEDGER-2.md"])).toBe(
      "LEDGER-3.md",
    );
    expect(ledgerFileName(["LEDGER.md"])).toBe("LEDGER-1.md");
  });
});

describe("sharedTmpEntryIsWorlds", () => {
  const world = {
    runId: self.runId,
    dir: `/tmp/sandcastle-verify/${self.runId}`,
  };

  it("claims a shared $TMPDIR entry only when its name or content names the world", () => {
    expect(sharedTmpEntryIsWorlds("sandcastle-git-Ab12", [], world)).toBe(
      false,
    );
    expect(
      sharedTmpEntryIsWorlds(
        "sandcastle-git-Ab12",
        ["gitdir: /home/agent/.sandcastle-parent-git/worktrees/x\n"],
        world,
      ),
    ).toBe(false);
    expect(
      sharedTmpEntryIsWorlds(
        "sandcastle-bundle-Zz",
        [`ref ${world.dir}/world-${self.runId}`],
        world,
      ),
    ).toBe(true);
    expect(
      sharedTmpEntryIsWorlds(`sandcastle-copyin-${self.runId}`, [], world),
    ).toBe(true);
  });
});
