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

describe("server operative routes", () => {
  it("lists operatives and returns operative details", async () => {
    const deps = makeDeps(makeRepo());
    const server = await startServer({ token: "secret", ...deps });
    const headers = { authorization: "Bearer secret" };
    try {
      const listResponse = await fetch(
        `http://127.0.0.1:${server.port}/operatives`,
        { headers },
      );
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        operatives: [{ id: "pi-default" }],
      });

      const detailResponse = await fetch(
        `http://127.0.0.1:${server.port}/operatives/pi-default`,
        { headers },
      );
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({ id: "pi-default" });
    } finally {
      await server.close();
    }
  });

  it("returns 404 for missing operatives", async () => {
    const server = await startServer({
      token: "secret",
      ...makeDeps(makeRepo()),
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/operatives/missing`,
        { headers: { authorization: "Bearer secret" } },
      );
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
