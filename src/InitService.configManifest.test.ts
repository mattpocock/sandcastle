import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getAgent,
  getIssueTracker,
  getNextStepsLines,
} from "./InitService.js";
import type { ScaffoldOptions } from "./InitService.js";
import { VERSION } from "./version.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const claudeCodeAgent = getAgent("claude-code")!;
const githubIssues = getIssueTracker("github-issues")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-8",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

describe("scaffold in a repo without a root package.json", () => {
  it("writes a package.json inside .sandcastle/", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    await expect(
      access(join(dir, ".sandcastle", "package.json")),
    ).resolves.toBeUndefined();
  });

  it("the config manifest declares @ai-hero/sandcastle and tsx as dependencies", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const manifest = JSON.parse(
      await readFile(join(dir, ".sandcastle", "package.json"), "utf-8"),
    ) as Record<string, unknown>;
    const deps = manifest["dependencies"] as Record<string, string>;
    expect(deps["@ai-hero/sandcastle"]).toBe(`^${VERSION}`);
    expect(deps["tsx"]).toBeDefined();
  });

  it("the config manifest is private and ESM", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const manifest = JSON.parse(
      await readFile(join(dir, ".sandcastle", "package.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(manifest["private"]).toBe(true);
    expect(manifest["type"]).toBe("module");
  });

  it("reports createdConfigManifest: true in the scaffold result", async () => {
    const dir = await makeDir();
    const result = await runScaffold(dir);
    expect(result.createdConfigManifest).toBe(true);
  });
});

describe("scaffold in a repo with a root package.json", () => {
  it("does not write a package.json inside .sandcastle/", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "host", type: "module" }),
    );
    await runScaffold(dir);

    await expect(
      access(join(dir, ".sandcastle", "package.json")),
    ).rejects.toThrow();
  });

  it("reports createdConfigManifest: false in the scaffold result", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "host" }),
    );
    const result = await runScaffold(dir);
    expect(result.createdConfigManifest).toBe(false);
  });
});

describe("getNextStepsLines with a config manifest", () => {
  const lines = (template: string, configManifest: boolean) =>
    getNextStepsLines(
      template,
      "main.mts",
      githubIssues,
      claudeCodeAgent,
      "npm",
      { configManifest },
    ).join("\n");

  it("tells the user to install dependencies inside .sandcastle/", () => {
    expect(lines("blank", true)).toContain("npm install --prefix .sandcastle");
  });

  it("does not suggest adding a script to the host package.json", () => {
    expect(lines("blank", true)).not.toContain("to your package.json scripts");
  });

  it("tells the user to run the main file directly with npx tsx", () => {
    expect(lines("blank", true)).toContain("npx tsx .sandcastle/main.mts");
  });

  it("keeps the package.json script step when there is no config manifest", () => {
    expect(lines("blank", false)).toContain("package.json scripts");
    expect(lines("blank", false)).not.toContain(
      "npm install --prefix .sandcastle",
    );
  });

  it("adapts the non-blank templates too", () => {
    const out = lines("simple-loop", true);
    expect(out).toContain("npm install --prefix .sandcastle");
    expect(out).not.toContain("to your package.json scripts");
  });
});
