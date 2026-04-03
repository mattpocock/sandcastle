import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getNextStepsLines,
  listAgents,
  getAgent,
  listTemplates,
} from "./InitService.js";
import type { ScaffoldOptions } from "./InitService.js";
import { SANDBOX_WORKSPACE_DIR } from "./SandboxFactory.js";
import { SKELETON_PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const claudeCodeAgent = getAgent("claude-code")!;
const piAgent = getAgent("pi")!;
const codexAgent = getAgent("codex")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-6",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

describe("Agent registry", () => {
  it("listAgents returns at least claude-code", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "claude-code")).toBe(true);
  });

  it("getAgent returns claude-code entry with expected fields", () => {
    const agent = getAgent("claude-code");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("claude-code");
    expect(agent!.defaultModel).toBe("claude-opus-4-6");
    expect(agent!.factoryImport).toBe("claudeCode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
  });

  it("getAgent returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });

  it("listAgents includes pi", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "pi")).toBe(true);
  });

  it("getAgent returns pi entry with expected fields", () => {
    const agent = getAgent("pi");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("pi");
    expect(agent!.defaultModel).toBe("claude-sonnet-4-6");
    expect(agent!.factoryImport).toBe("pi");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain(
      "@mariozechner/pi-coding-agent",
    );
  });

  it("listAgents includes codex", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "codex")).toBe(true);
  });

  it("getAgent returns codex entry with expected fields", () => {
    const agent = getAgent("codex");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("codex");
    expect(agent!.defaultModel).toBe("gpt-5.4-mini");
    expect(agent!.factoryImport).toBe("codex");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("@openai/codex");
  });
});

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

describe("InitService scaffold", () => {
  it("uses agent dockerfileTemplate for Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toBe(claudeCodeAgent.dockerfileTemplate);
  });

  it("copies .env.example from template directory", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).toContain("GH_TOKEN=");
  });

  it("does not scaffold config.json for blank template", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "config.json")),
    ).rejects.toThrow();
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".sandcastle"));

    await expect(runScaffold(dir)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes .env, logs/, and worktrees/ in .gitignore but not patches/", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain("worktrees/");
    expect(gitignore).not.toContain("patches/");
  });

  it("Dockerfile template contains workspace mount comment", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_WORKSPACE_DIR);
  });

  it("claude-code Dockerfile template does not install pnpm or enable corepack", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).not.toContain("pnpm");
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("# ");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("blank template produces skeleton prompt and main.ts", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const configDir = join(dir, ".sandcastle");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.ts"))).resolves.toBeUndefined();
  });

  it("blank template main.ts imports from @ai-hero/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('"@ai-hero/sandcastle"');
  });

  it("blank template main.ts calls run()", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain("run(");
  });

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "blank" });

    const prompt1 = await readFile(
      join(dir1, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt1).toBe(prompt2);
  });

  // --- main.ts rewriting ---

  it("scaffolds main.ts with the specified model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { model: "claude-sonnet-4-6" });

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('claudeCode("claude-sonnet-4-6")');
    // Should not contain the template's original model
    expect(mainTs).not.toContain('claudeCode("claude-opus-4-6")');
  });

  it("scaffolds main.ts with default model when using agent default", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('claudeCode("claude-opus-4-6")');
  });

  // --- Template-specific tests ---

  it("simple-loop template produces main.ts and prompt.md", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const configDir = join(dir, ".sandcastle");
    const { access } = await import("node:fs/promises");

    await expect(access(join(configDir, "main.ts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("simple-loop main.ts imports from @ai-hero/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('"@ai-hero/sandcastle"');
  });

  it("simple-loop main.ts contains sandcastle.run() with expected options", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("3");
    // When scaffolded with default model, simple-loop uses claude-opus-4-6
    // (rewritten from template's claude-sonnet-4-6)
    expect(mainTs).toContain("promptFile");
    expect(mainTs).toContain("npm install");
    expect(mainTs).toContain("onSandboxReady");
  });

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  describe("sequential-reviewer template", () => {
    it("produces main.ts, implement-prompt.md, and review-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(access(join(configDir, "main.ts"))).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.ts imports from @ai-hero/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ai-hero/sandcastle"');
    });

    it("main.ts calls sandcastle.run() twice per iteration (implement + review)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("sandcastle");
      const runCallCount = (mainTs.match(/\.run\(/g) ?? []).length;
      expect(runCallCount).toBeGreaterThanOrEqual(2);
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
    });

    it("main.ts passes branch from implement result to review run", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("branch");
    });

    it("implement-prompt.md contains {{ISSUE_NUMBER}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{ISSUE_NUMBER}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("sequential-reviewer appears in listTemplates()", async () => {
      const templates = listTemplates();
      expect(templates.some((t) => t.name === "sequential-reviewer")).toBe(
        true,
      );
    });
  });

  it("simple-loop template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, ".sandcastle"));
    const compiledFiles = files.filter(
      (f) =>
        f.endsWith(".js") ||
        f.endsWith(".d.ts") ||
        f.endsWith(".js.map") ||
        f.endsWith(".d.ts.map"),
    );
    expect(compiledFiles).toEqual([]);
  });

  describe("getNextStepsLines", () => {
    it("blank template returns steps mentioning .env and main.ts (not npx sandcastle run)", () => {
      const lines = getNextStepsLines("blank");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toContain("main.ts");
      expect(joined).not.toContain("npx sandcastle run");
    });

    it("non-blank template returns steps mentioning .env, package.json scripts, and npm run sandcastle", () => {
      const lines = getNextStepsLines("simple-loop");
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toContain("package.json");
      expect(joined).toContain("npm run sandcastle");
    });

    it("non-blank template includes a note about the install hook", () => {
      const lines = getNextStepsLines("simple-loop");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install");
    });

    it("non-blank template mentions copyToSandbox and node_modules", () => {
      const lines = getNextStepsLines("simple-loop");
      const joined = lines.join("\n");
      expect(joined).toContain("copyToSandbox");
      expect(joined).toContain("node_modules");
    });

    it("blank template includes a step to customize prompt.md", () => {
      const lines = getNextStepsLines("blank");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt.md");
    });

    it("simple-loop template includes a step to read/customize prompt files", () => {
      const lines = getNextStepsLines("simple-loop");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("sequential-reviewer template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("sequential-reviewer");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("parallel-planner template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("parallel-planner");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("returns at least 2 numbered steps for blank template", () => {
      const lines = getNextStepsLines("blank");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns at least 3 numbered steps for non-blank templates", () => {
      const lines = getNextStepsLines("simple-loop");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
    });

    it("uses pnpm in next steps when packageManager is pnpm", () => {
      const lines = getNextStepsLines("simple-loop", "pnpm");
      const joined = lines.join("\n");
      expect(joined).toContain("pnpm run sandcastle");
      expect(joined).toContain("pnpm install");
      // "pnpm run" contains "npm run" as substring, so check no standalone "npm run"
      expect(joined).not.toMatch(/(?<![p])npm run/);
      expect(joined).not.toMatch(/(?<![p])npm install/);
    });

    it("uses yarn in next steps when packageManager is yarn", () => {
      const lines = getNextStepsLines("simple-loop", "yarn");
      const joined = lines.join("\n");
      expect(joined).toContain("yarn run sandcastle");
      expect(joined).toContain("yarn install");
    });

    it("uses bun in next steps when packageManager is bun", () => {
      const lines = getNextStepsLines("simple-loop", "bun");
      const joined = lines.join("\n");
      expect(joined).toContain("bun run sandcastle");
      expect(joined).toContain("bun install");
    });

    it("uses pnpm in blank template next steps", () => {
      const lines = getNextStepsLines("blank", "pnpm");
      const joined = lines.join("\n");
      expect(joined).toContain("pnpm run sandcastle");
    });
  });

  it("scaffolds pi agent with pi Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toBe(piAgent.dockerfileTemplate);
    expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
  });

  it("scaffolds main.ts with pi factory import when pi agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('pi("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds codex agent with codex Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toBe(codexAgent.dockerfileTemplate);
    expect(dockerfile).toContain("@openai/codex");
  });

  it("scaffolds main.ts with codex factory import when codex agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('codex("gpt-5.4-mini")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  describe("parallel-planner template", () => {
    it("produces main.ts, plan-prompt.md, implement-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(access(join(configDir, "main.ts"))).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.ts uses npm install hook and imports sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("npm install");
      expect(mainTs).toContain("sandcastle");
    });

    it("main.ts imports from @ai-hero/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ai-hero/sandcastle"');
    });

    it("main.ts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      // All factory calls should use the specified model (default: claude-opus-4-6)
      expect(mainTs).toContain("claude-opus-4-6");
    });

    it("implement-prompt.md contains {{ISSUE_NUMBER}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{ISSUE_NUMBER}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("main.ts always uses the merge agent regardless of branch count", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("completedBranches.length === 1");
    });

    it("common files are still generated with parallel-planner template", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toBe(claudeCodeAgent.dockerfileTemplate);

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain("ANTHROPIC_API_KEY=");
    });
  });

  // -------------------------------------------------------------------------
  // Package manager support
  // -------------------------------------------------------------------------

  describe("package manager support", () => {
    it("scaffolds with npm by default (no Dockerfile changes)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).not.toContain("corepack");
      expect(dockerfile).not.toContain("pnpm");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("npm install");
    });

    it("scaffolds with pnpm: Dockerfile installs pnpm, main.ts uses pnpm", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        packageManager: { name: "pnpm", version: "9.1.0" },
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("corepack enable");
      expect(dockerfile).toContain("corepack prepare pnpm@9.1.0 --activate");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("pnpm install");
      expect(mainTs).not.toMatch(/(?<![p])npm install/);
    });

    it("scaffolds with yarn: Dockerfile installs yarn via corepack", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        packageManager: { name: "yarn", version: "4.0.0" },
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("corepack enable");
      expect(dockerfile).toContain("corepack prepare yarn@4.0.0 --activate");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("yarn install");
    });

    it("scaffolds with bun: Dockerfile installs bun via npm", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        packageManager: { name: "bun" },
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("npm install -g bun");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("bun install");
    });

    it("pnpm without version uses latest", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        packageManager: { name: "pnpm" },
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("corepack prepare pnpm@latest --activate");
    });

    it("strips +sha512 hash from version in Dockerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        packageManager: {
          name: "pnpm",
          version: "10.30.3+sha512.abc123def",
        },
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("corepack prepare pnpm@10.30.3 --activate");
      expect(dockerfile).not.toContain("sha512");
    });

    it("inserts package manager install before USER line (runs as root)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        packageManager: { name: "pnpm", version: "9.1.0" },
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      const corepackIdx = dockerfile.indexOf("corepack enable");
      const userIdx = dockerfile.indexOf("USER agent");
      expect(corepackIdx).toBeGreaterThan(-1);
      expect(userIdx).toBeGreaterThan(-1);
      expect(corepackIdx).toBeLessThan(userIdx);
    });

    it("substitutes package manager in prompt .md files", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        packageManager: { name: "pnpm" },
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("pnpm run typecheck");
      expect(prompt).toContain("pnpm run test");
      expect(prompt).not.toMatch(/(?<![p])npm run/);
    });

    it("substitutes package manager in sequential-reviewer template files", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        packageManager: { name: "yarn" },
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("yarn install");

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("yarn run typecheck");
    });

    it("substitutes package manager in parallel-planner template files", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        packageManager: { name: "bun" },
      });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("bun install");

      const mergePrompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(mergePrompt).toContain("bun run typecheck");
    });
  });
});
