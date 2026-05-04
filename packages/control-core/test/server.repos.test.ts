import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperativeStore } from "../src/operatives/OperativeStore.js";
import { GlobalRepoStore } from "../src/repos/GlobalRepoStore.js";
import { RepoRegistry } from "../src/repos/RepoRegistry.js";
import { startServer } from "../src/server.js";
import { makeRepo } from "./helpers.js";

const homes: string[] = [];

const makeIsolatedServerDeps = (repo: string) => {
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

describe("server repo routes", () => {
  it("requires bearer auth", async () => {
    const server = await startServer({
      token: "secret",
      ...makeIsolatedServerDeps(makeRepo()),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/repos`);
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("gets, posts, and deletes repos", async () => {
    const firstRepo = makeRepo();
    const secondRepo = makeRepo();
    const server = await startServer({
      token: "secret",
      ...makeIsolatedServerDeps(firstRepo),
    });
    const headers = { authorization: "Bearer secret" };
    try {
      const listResponse = await fetch(
        `http://127.0.0.1:${server.port}/repos`,
        { headers },
      );
      expect(listResponse.status).toBe(200);
      const list = (await listResponse.json()) as { repos: unknown[] };
      expect(list.repos).toHaveLength(1);

      const postResponse = await fetch(
        `http://127.0.0.1:${server.port}/repos`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ root: secondRepo }),
        },
      );
      expect(postResponse.status).toBe(200);
      const added = (await postResponse.json()) as { id: string; root: string };
      expect(added.root).toBe(secondRepo);

      const deleteResponse = await fetch(
        `http://127.0.0.1:${server.port}/repos/${added.id}`,
        { method: "DELETE", headers },
      );
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toEqual({ removed: true });
    } finally {
      await server.close();
    }
  });
});
