import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager, zodInstallCommand } from "./cli.js";

const makeDir = () => mkdtemp(join(tmpdir(), "cli-template-deps-"));

describe("template dependency package manager detection", () => {
  it("uses packageManager when present", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.0.0" }),
    );

    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("detects bun, yarn, pnpm, and npm install commands", () => {
    expect(zodInstallCommand("bun")).toBe("bun add zod");
    expect(zodInstallCommand("yarn")).toBe("yarn add zod");
    expect(zodInstallCommand("pnpm")).toBe("pnpm add zod");
    expect(zodInstallCommand("npm")).toBe("npm install zod");
  });

  it("falls back to lockfiles and then npm", async () => {
    const pnpmDir = await makeDir();
    await writeFile(join(pnpmDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(pnpmDir)).toBe("pnpm");

    const bunDir = await makeDir();
    await writeFile(join(bunDir, "bun.lock"), "");
    expect(detectPackageManager(bunDir)).toBe("bun");

    const yarnDir = await makeDir();
    await writeFile(join(yarnDir, "yarn.lock"), "");
    expect(detectPackageManager(yarnDir)).toBe("yarn");

    const npmDir = await makeDir();
    expect(detectPackageManager(npmDir)).toBe("npm");
  });
});
