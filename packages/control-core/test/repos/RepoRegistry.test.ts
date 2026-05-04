import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalRepoStore } from "../../src/repos/GlobalRepoStore.js";
import { RepoRegistry } from "../../src/repos/RepoRegistry.js";
import { makeRepo } from "../helpers.js";

const homes: string[] = [];

const makeStore = (): GlobalRepoStore => {
  const home = mkdtempSync(join(tmpdir(), "sandcastle-home-"));
  homes.push(home);
  return new GlobalRepoStore(join(home, ".sandcastle"));
};

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("RepoRegistry", () => {
  it("registerRepo dedupes by root", () => {
    const repo = makeRepo();
    const registry = new RepoRegistry(repo, makeStore());

    const first = registry.registerRepo(repo);
    const second = registry.registerRepo(repo);

    expect(second.id).toBe(first.id);
    expect(registry.listRepos()).toHaveLength(1);
  });

  it("removes repos", () => {
    const registry = new RepoRegistry(makeRepo(), makeStore());
    const repo = registry.registerRepo(makeRepo());

    expect(registry.removeRepo(repo.id)).toBe(true);
    expect(registry.removeRepo(repo.id)).toBe(false);
    expect(registry.listRepos().map((entry) => entry.id)).not.toContain(
      repo.id,
    );
  });

  it("sorts repos by most recent open time", async () => {
    const first = makeRepo();
    const second = makeRepo();
    const registry = new RepoRegistry(first, makeStore());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const registeredSecond = registry.registerRepo(second);

    expect(registry.listRepos()[0]?.id).toBe(registeredSecond.id);
  });

  it("validates .sandcastle exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-not-ready-"));
    homes.push(dir);

    expect(() => new RepoRegistry(dir, makeStore())).toThrow(/not initialized/);
  });
});
