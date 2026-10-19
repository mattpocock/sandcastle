import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { transformRunMany } from "./runMany.js";
import { runRunManyCodemod } from "./runCodemod.js";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "run-many");
const cases = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".input.txt"))
  .map((f) => f.replace(".input.txt", ""));

describe("run-many codemod fixtures", () => {
  it("has fixtures", () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  for (const name of cases) {
    it(`${name}: input → expected output`, () => {
      const input = readFileSync(join(FIXTURES, `${name}.input.txt`), "utf8");
      const expected = readFileSync(
        join(FIXTURES, `${name}.output.txt`),
        "utf8",
      );
      expect(transformRunMany(ts, input, `${name}.ts`).output).toBe(expected);
    });

    it(`${name}: is idempotent`, () => {
      const expected = readFileSync(
        join(FIXTURES, `${name}.output.txt`),
        "utf8",
      );
      const again = transformRunMany(ts, expected, `${name}.ts`);
      expect(again.changed).toBe(false);
      expect(again.output).toBe(expected);
    });
  }

  it("loop fixture keeps the loop result shape on runMany()", () => {
    // iterations/completionSignal still exist on RunManyResult, so a
    // converted call's result access is left alone.
    const out = readFileSync(
      join(FIXTURES, "loop-named-import.output.txt"),
      "utf8",
    );
    expect(out).toContain("await runMany({");
    expect(out).toContain(
      'import { claudeCode, runMany } from "@ai-hero/sandcastle"',
    );
  });
});

describe("runRunManyCodemod (file walking)", () => {
  it("rewrites files in a directory, skips node_modules, and honours --dry-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-codemod-"));
    try {
      const src = readFileSync(
        join(FIXTURES, "loop-named-import.input.txt"),
        "utf8",
      );
      await mkdir(join(dir, ".sandcastle"), { recursive: true });
      await mkdir(join(dir, "node_modules", "x"), { recursive: true });
      await writeFile(join(dir, ".sandcastle", "main.mts"), src);
      await writeFile(join(dir, "node_modules", "x", "index.ts"), src);

      const dry = await runRunManyCodemod({
        paths: ["."],
        cwd: dir,
        dryRun: true,
        ts,
      });
      expect(dry.map((r) => r.file)).toEqual([
        join(dir, ".sandcastle", "main.mts"),
      ]);
      expect(await readFile(join(dir, ".sandcastle", "main.mts"), "utf8")).toBe(
        src,
      );

      await runRunManyCodemod({ paths: [".sandcastle"], cwd: dir, ts });
      expect(
        await readFile(join(dir, ".sandcastle", "main.mts"), "utf8"),
      ).toContain("await runMany({");
      expect(
        await readFile(join(dir, "node_modules", "x", "index.ts"), "utf8"),
      ).toBe(src);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
