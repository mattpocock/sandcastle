import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectPackageManager,
  addDependencyCommand,
  installDependenciesCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

describe("detectPackageManager", () => {
  const detect = (dir: string) =>
    Effect.runPromise(
      detectPackageManager(dir).pipe(Effect.provide(NodeFileSystem.layer)),
    );

  it("defaults to npm when no lockfile or packageManager field is present", async () => {
    const dir = await makeDir();
    expect(await detect(dir)).toBe("npm");
  });

  it.each([
    { file: "pnpm-lock.yaml", expected: "pnpm" },
    { file: "yarn.lock", expected: "yarn" },
    { file: "bun.lockb", expected: "bun" },
    { file: "bun.lock", expected: "bun" },
    { file: "package-lock.json", expected: "npm" },
  ])("detects $expected from $file", async ({ file, expected }) => {
    const dir = await makeDir();
    await writeFile(join(dir, file), "");
    expect(await detect(dir)).toBe(expected);
  });

  it("prefers the package.json packageManager field over a lockfile", async () => {
    const dir = await makeDir();
    // Lockfile says npm, but the explicit field says pnpm — field wins.
    await writeFile(join(dir, "package-lock.json"), "");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", packageManager: "pnpm@9.1.0" }),
    );
    expect(await detect(dir)).toBe("pnpm");
  });

  it("ignores an unrecognized packageManager field and falls back to lockfile", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "yarn.lock"), "");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", packageManager: "deno@1.0.0" }),
    );
    expect(await detect(dir)).toBe("yarn");
  });
});

describe("addDependencyCommand", () => {
  it.each([
    { pm: "npm" as const, expected: "npm install zod" },
    { pm: "pnpm" as const, expected: "pnpm add zod" },
    { pm: "yarn" as const, expected: "yarn add zod" },
    { pm: "bun" as const, expected: "bun add zod" },
  ])("$pm builds '$expected'", ({ pm, expected }) => {
    expect(addDependencyCommand(pm, "zod")).toBe(expected);
  });
});

describe("installDependenciesCommand", () => {
  it.each([
    { pm: "npm" as const, expected: "npm install" },
    { pm: "pnpm" as const, expected: "pnpm install" },
    { pm: "yarn" as const, expected: "yarn install" },
    { pm: "bun" as const, expected: "bun install" },
  ])("$pm builds '$expected'", ({ pm, expected }) => {
    expect(installDependenciesCommand(pm)).toBe(expected);
  });
});

describe("hostHasDependency", () => {
  const has = (dir: string, pkg: string) =>
    Effect.runPromise(
      hostHasDependency(dir, pkg).pipe(Effect.provide(NodeFileSystem.layer)),
    );

  it("returns false when there is no package.json", async () => {
    const dir = await makeDir();
    expect(await has(dir, "zod")).toBe(false);
  });

  it("returns false when the package is not declared", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { effect: "^3" } }),
    );
    expect(await has(dir, "zod")).toBe(false);
  });

  it.each(["dependencies", "devDependencies"])(
    "returns true when the package is in %s",
    async (key) => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", [key]: { zod: "^3" } }),
      );
      expect(await has(dir, "zod")).toBe(true);
    },
  );
});

describe("getTemplateDependencies", () => {
  it("reports zod as a dependency of the planner templates", () => {
    expect(getTemplateDependencies("parallel-planner")).toContain("zod");
    expect(getTemplateDependencies("parallel-planner-with-review")).toContain(
      "zod",
    );
  });

  it("reports no dependencies for templates that don't need a schema validator", () => {
    expect(getTemplateDependencies("simple-loop")).not.toContain("zod");
    expect(getTemplateDependencies("blank")).not.toContain("zod");
  });
});
