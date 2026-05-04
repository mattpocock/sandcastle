import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalRepoStore } from "../../src/repos/GlobalRepoStore.js";
import { makeRepo } from "../helpers.js";

const homes: string[] = [];

const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "sandcastle-home-"));
  homes.push(home);
  return home;
};

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("GlobalRepoStore", () => {
  it("persists repos.json under a temp Sandcastle home", () => {
    const home = makeHome();
    const repo = makeRepo();
    const store = new GlobalRepoStore(join(home, ".sandcastle"));

    const registered = store.registerRepo(repo);

    expect(store.listRepos()).toEqual([registered]);
    expect(existsSync(join(home, ".sandcastle", "repos.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(home, ".sandcastle", "repos.json"), "utf8")),
    ).toMatchObject({ version: 1, repos: [{ id: registered.id, root: repo }] });
  });

  it("writes via tmp-and-rename without leaving tmp files behind", () => {
    const home = makeHome();
    const store = new GlobalRepoStore(join(home, ".sandcastle"));

    store.registerRepo(makeRepo());
    store.registerRepo(makeRepo());

    const files = readdirSync(join(home, ".sandcastle"));
    expect(files).toContain("repos.json");
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });
});
