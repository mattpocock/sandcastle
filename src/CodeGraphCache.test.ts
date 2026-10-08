import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeGraphCacheKey, prepareCodeGraphCache } from "./CodeGraphCache.js";

describe("CodeGraph branch cache", () => {
  it("isolates deterministic branch caches and rejects traversal", () => {
    expect(codeGraphCacheKey("sandcastle/issue-3")).toBe("sandcastle--issue-3");
    expect(codeGraphCacheKey("sandcastle/issue-3")).not.toBe(
      codeGraphCacheKey("sandcastle/issue-5"),
    );
    expect(() => codeGraphCacheKey("../outside")).toThrow(
      "Invalid CodeGraph branch",
    );
  });

  it("seeds a branch once without overwriting its updated index", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandcastle-codegraph-"));
    const seedDatabase = join(directory, "seed.db");
    const cacheRoot = join(directory, "cache");
    await writeFile(seedDatabase, "base-index");

    const cacheDirectory = prepareCodeGraphCache({
      cacheRoot,
      branch: "sandcastle/issue-3",
      seedDatabase,
    });
    const cacheDatabase = join(cacheDirectory, "codegraph.db");
    expect(await readFile(cacheDatabase, "utf8")).toBe("base-index");

    await writeFile(cacheDatabase, "branch-index");
    prepareCodeGraphCache({
      cacheRoot,
      branch: "sandcastle/issue-3",
      seedDatabase,
    });
    expect(await readFile(cacheDatabase, "utf8")).toBe("branch-index");
  });
});
