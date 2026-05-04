import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperativeStore } from "../../src/operatives/OperativeStore.js";
import { makeRepo } from "../helpers.js";
import type {
  OperativeIdentity,
  OperativeRepoRecord,
} from "@sandcastle/protocol";

const homes: string[] = [];

const makeStore = (): OperativeStore => {
  const home = mkdtempSync(join(tmpdir(), "sandcastle-home-"));
  homes.push(home);
  return new OperativeStore(join(home, ".sandcastle"));
};

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("OperativeStore", () => {
  it("seeds pi-default when no operatives exist", () => {
    const store = makeStore();

    expect(store.listIdentities().map((identity) => identity.id)).toEqual([
      "pi-default",
    ]);
  });

  it("round-trips identity records", () => {
    const store = makeStore();
    const identity: OperativeIdentity = {
      id: "codex-one",
      codename: "Codex One",
      provider: "codex",
      model: "gpt-5.4",
      species: "synthetic",
      className: "Builder",
      level: 2,
      globalXp: 10,
      bond: 1,
      streak: 1,
      concurrencyCap: 2,
      sleeveCardIds: [],
      unlockedTraits: ["steady"],
    };

    store.upsertIdentity(identity);

    expect(store.getIdentity(identity.id)).toEqual(identity);
  });

  it("round-trips repo records and returns undefined when missing", () => {
    const store = makeStore();
    const repo = makeRepo();
    const record: OperativeRepoRecord = {
      operativeId: "pi-default",
      planetId: "planet-local",
      firstLandedAt: "2026-01-01T00:00:00.000Z",
      lastLandedAt: "2026-01-02T00:00:00.000Z",
      runIds: ["run_1"],
      victoriesCount: 1,
      defeatsCount: 0,
      planetSpecificBond: 2,
      scarsEarnedHere: [],
    };

    expect(store.getRepoRecord(repo, "pi-default")).toBeUndefined();
    store.upsertRepoRecord(repo, record);
    expect(store.getRepoRecord(repo, "pi-default")).toEqual(record);
  });
});
