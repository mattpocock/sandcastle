import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperativeStore } from "../src/operatives/OperativeStore.js";
import { GlobalRepoStore } from "../src/repos/GlobalRepoStore.js";
import { RepoRegistry } from "../src/repos/RepoRegistry.js";
import { startServer } from "../src/server.js";
import { makeRepo } from "./helpers.js";

const homes: string[] = [];

const makeDeps = (repo: string) => {
  const home = mkdtempSync(join(tmpdir(), "sandcastle-home-"));
  homes.push(home);
  return {
    repoRegistry: new RepoRegistry(
      repo,
      new GlobalRepoStore(join(home, ".sandcastle")),
    ),
    operativeStore: new OperativeStore(join(home, ".sandcastle")),
  };
};

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("server deck routes", () => {
  it("returns a deck for a registered repo", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".sandcastle", "skills"), { recursive: true });
    writeFileSync(
      join(repo, ".sandcastle", "agents.md"),
      "---\ntitle: Agents\n---\nMode body.\n",
    );
    writeFileSync(
      join(repo, ".sandcastle", "skills", "tests.md"),
      "---\ntitle: Testing\n---\nTest body.\n",
    );
    const deps = makeDeps(repo);
    const id = deps.repoRegistry.listRepos()[0]!.id;
    const server = await startServer({ token: "secret", ...deps });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/repos/${id}/deck`,
        { headers: { authorization: "Bearer secret" } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        version: 1,
        mode: { title: "Agents" },
        skills: [{ title: "Testing" }],
      });
    } finally {
      await server.close();
    }
  });
});
