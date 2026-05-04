import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  zOperativeIdentity,
  zOperativeRepoRecord,
  type OperativeIdentity,
  type OperativeRepoRecord,
} from "@sandcastle/protocol";
import {
  atomicWriteJson,
  resolveSandcastleHome,
} from "../repos/GlobalRepoStore.js";

const DEFAULT_OPERATIVE: OperativeIdentity = {
  id: "pi-default",
  codename: "Pi Default",
  provider: "pi",
  model: "pi",
  species: "synthetic",
  className: "Surgeon",
  level: 1,
  globalXp: 0,
  bond: 0,
  streak: 0,
  concurrencyCap: 1,
  sleeveCardIds: [],
  unlockedTraits: [],
};

export class OperativeStore {
  private readonly operativesDir: string;

  constructor(homeDir = resolveSandcastleHome()) {
    this.operativesDir = join(homeDir, "operatives");
    mkdirSync(this.operativesDir, { recursive: true });
    this.seedDefaultIfEmpty();
  }

  listIdentities(): OperativeIdentity[] {
    return readdirSync(this.operativesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.readIdentity(join(this.operativesDir, entry.name)))
      .sort((a, b) => a.codename.localeCompare(b.codename));
  }

  getIdentity(id: string): OperativeIdentity | undefined {
    const path = this.identityPath(id);
    if (!existsSync(path)) return undefined;
    return this.readIdentity(path);
  }

  upsertIdentity(identity: OperativeIdentity): void {
    atomicWriteJson(
      this.identityPath(identity.id),
      zOperativeIdentity.parse(identity),
    );
  }

  getRepoRecord(
    repoRoot: string,
    operativeId: string,
  ): OperativeRepoRecord | undefined {
    const path = this.repoRecordPath(repoRoot, operativeId);
    if (!existsSync(path)) return undefined;
    return zOperativeRepoRecord.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  upsertRepoRecord(repoRoot: string, record: OperativeRepoRecord): void {
    atomicWriteJson(
      this.repoRecordPath(repoRoot, record.operativeId),
      zOperativeRepoRecord.parse(record),
    );
  }

  private seedDefaultIfEmpty(): void {
    const hasOperatives = readdirSync(this.operativesDir, {
      withFileTypes: true,
    }).some((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (!hasOperatives) this.upsertIdentity(DEFAULT_OPERATIVE);
  }

  private readIdentity(path: string): OperativeIdentity {
    return zOperativeIdentity.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  private identityPath(id: string): string {
    return join(this.operativesDir, `${safeId(id)}.json`);
  }

  private repoRecordPath(repoRoot: string, operativeId: string): string {
    const path = join(
      repoRoot,
      ".sandcastle",
      "state",
      `operatives.${safeId(operativeId)}.json`,
    );
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }
}

const safeId = (id: string): string => {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid operative id: ${id}`);
  }
  return id;
};
