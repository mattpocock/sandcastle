import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffold, getNextStepsLines } from "./InitService.js";
import type { AgentProvider } from "./AgentProvider.js";
import { claudeCodeProvider } from "./AgentProvider.js";
import { SANDBOX_WORKSPACE_DIR } from "./SandboxFactory.js";
import { SKELETON_PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const runScaffold = (...args: Parameters<typeof scaffold>) =>
  Effect.runPromise(
    scaffold(...args).pipe(Effect.provide(NodeFileSystem.layer)),
  );

const fakeProvider: AgentProvider = {
  name: "fake-agent",
  defaultModel: "fake-model-1",
  envManifest: {
    FAKE_TOKEN: "Fake agent token",
    FAKE_SECRET: "Fake agent secret",
  },
  dockerfileTemplate: "FROM ubuntu:latest\nRUN echo fake\n",
  buildPrintCommand: ({ model, prompt }) =>
    `fake-agent --print --model ${model} '${prompt}'`,
  buildInteractiveArgs: ({ model }) => ["fake-agent", "--model", model],
  parseStreamLine: () => [],
};

describe("InitService scaffold", () => {
  it("uses provider envManifest for .env.example", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider);

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("FAKE_TOKEN=");
    expect(envExample).toContain("FAKE_SECRET=");
    // Comments from manifest should be present
    expect(envExample).toContain("# Fake agent token");
    expect(envExample).toContain("# Fake agent secret");
    // Should NOT contain hardcoded claude-code keys
    expect(envExample).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("uses provider dockerfileTemplate for Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toBe(fakeProvider.dockerfileTemplate);
  });

  it("does not scaffold config.json for blank template", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider);

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "config.json")),
    ).rejects.toThrow();
  });

  it("scaffolds claude-code provider correctly", async () => {
    const dir = await makeDir();
    await runScaffold(dir, claudeCodeProvider);

    const configDir = join(dir, ".sandcastle");

    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toBe(claudeCodeProvider.dockerfileTemplate);

    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).toContain("GH_TOKEN=");
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));

    await expect(runScaffold(dir, fakeProvider)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes .env, logs/, and worktrees/ in .gitignore but not patches/", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider);

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
    await runScaffold(dir, claudeCodeProvider);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_WORKSPACE_DIR);
  });

  it("claude-code Dockerfile template does not install pnpm or enable corepack", async () => {
    const dir = await makeDir();
    await runScaffold(dir, claudeCodeProvider);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).not.toContain("pnpm");
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider);

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
    await runScaffold(dir, fakeProvider, "blank");

    const configDir = join(dir, ".sandcastle");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.ts"))).resolves.toBeUndefined();
  });

  it("blank template main.ts imports from @ai-hero/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "blank");

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('"@ai-hero/sandcastle"');
  });

  it("blank template main.ts calls run()", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "blank");

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain("run(");
  });

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1, fakeProvider);
    await runScaffold(dir2, fakeProvider, "blank");

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

  it("simple-loop template produces main.ts and prompt.md", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "simple-loop");

    const configDir = join(dir, ".sandcastle");
    const { access } = await import("node:fs/promises");

    // Both files must exist
    await expect(access(join(configDir, "main.ts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("simple-loop main.ts imports from @ai-hero/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "simple-loop");

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain('"@ai-hero/sandcastle"');
  });

  it("simple-loop main.ts contains sandcastle.run() with expected options", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "simple-loop");

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("3");
    expect(mainTs).toContain("claude-sonnet-4-6");
    expect(mainTs).toContain("promptFile");
    expect(mainTs).toContain("npm install");
    expect(mainTs).toContain("onSandboxReady");
  });

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "simple-loop");

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    // Shell expressions for dynamic context
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    // Completion signal
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  describe("sequential-reviewer template", () => {
    it("produces main.ts, implement-prompt.md, and review-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "sequential-reviewer");

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
      await runScaffold(dir, fakeProvider, "sequential-reviewer");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ai-hero/sandcastle"');
    });

    it("main.ts calls sandcastle.run() twice per iteration (implement + review)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "sequential-reviewer");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("sandcastle");
      // Two run() calls — implement and review
      const runCallCount = (mainTs.match(/\.run\(/g) ?? []).length;
      expect(runCallCount).toBeGreaterThanOrEqual(2);
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
    });

    it("main.ts passes branch from implement result to review run", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "sequential-reviewer");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("branch");
    });

    it("implement-prompt.md contains {{ISSUE_NUMBER}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "sequential-reviewer");

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
      await runScaffold(dir, fakeProvider, "sequential-reviewer");

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("sequential-reviewer appears in listTemplates()", async () => {
      const { listTemplates } = await import("./InitService.js");
      const templates = listTemplates();
      expect(templates.some((t) => t.name === "sequential-reviewer")).toBe(
        true,
      );
    });
  });

  it("simple-loop template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "simple-loop");

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
    it("blank template returns steps mentioning .env, main.ts, and JS API (not npx sandcastle run)", () => {
      const lines = getNextStepsLines("blank", fakeProvider);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const joined = lines.join("\n");
      expect(joined).toContain(".sandcastle/.env");
      expect(joined).toContain("main.ts");
      expect(joined).not.toContain("npx sandcastle run");
    });

    it("non-blank template returns steps mentioning .env, package.json scripts, and npm run sandcastle", () => {
      const lines = getNextStepsLines("simple-loop", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain(".sandcastle/.env");
      expect(joined).toContain("package.json");
      expect(joined).toContain("npm run sandcastle");
    });

    it("non-blank template includes a note about customizing the install command", () => {
      const lines = getNextStepsLines("simple-loop", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("npm install");
      expect(joined).toContain("onSandboxReady");
    });

    it("non-blank template mentions copyToSandbox and node_modules", () => {
      const lines = getNextStepsLines("simple-loop", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("copyToSandbox");
      expect(joined).toContain("node_modules");
    });

    it("blank template includes a step to customize prompt.md", () => {
      const lines = getNextStepsLines("blank", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("prompt.md");
    });

    it("simple-loop template includes a step to read/customize prompt files", () => {
      const lines = getNextStepsLines("simple-loop", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("sequential-reviewer template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("sequential-reviewer", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("parallel-planner template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("parallel-planner", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("returns at least 2 numbered steps for blank template", () => {
      const lines = getNextStepsLines("blank", fakeProvider);
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns at least 3 numbered steps for non-blank templates", () => {
      const lines = getNextStepsLines("simple-loop", fakeProvider);
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
    });

    it("lists env var names and descriptions from the provider envManifest", () => {
      const lines = getNextStepsLines("blank", fakeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("FAKE_TOKEN");
      expect(joined).toContain("Fake agent token");
      expect(joined).toContain("FAKE_SECRET");
      expect(joined).toContain("Fake agent secret");
    });

    it("lists claude-code provider env vars when using claudeCodeProvider", () => {
      const lines = getNextStepsLines("blank", claudeCodeProvider);
      const joined = lines.join("\n");
      expect(joined).toContain("ANTHROPIC_API_KEY");
      expect(joined).toContain("GH_TOKEN");
    });
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(runScaffold(dir, fakeProvider, "nonexistent")).rejects.toThrow(
      "nonexistent",
    );
  });

  it("common files are generated correctly regardless of template", async () => {
    const dir = await makeDir();
    await runScaffold(dir, fakeProvider, "blank");

    const configDir = join(dir, ".sandcastle");
    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toBe(fakeProvider.dockerfileTemplate);

    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    expect(envExample).toContain("FAKE_TOKEN=");
  });

  describe("parallel-planner template", () => {
    it("produces main.ts, plan-prompt.md, implement-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "parallel-planner");

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
      await runScaffold(dir, fakeProvider, "parallel-planner");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("npm install");
      expect(mainTs).toContain("sandcastle");
    });

    it("main.ts imports from @ai-hero/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "parallel-planner");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ai-hero/sandcastle"');
    });

    it("main.ts references opus for planning and sonnet for execution/merge", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "parallel-planner");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("claude-opus-4-6");
      expect(mainTs).toContain("claude-sonnet-4-6");
    });

    it("implement-prompt.md contains {{ISSUE_NUMBER}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "parallel-planner");

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
      await runScaffold(dir, fakeProvider, "parallel-planner");

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("main.ts always uses the merge agent regardless of branch count", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "parallel-planner");

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("completedBranches.length === 1");
    });

    it("common files are still generated with parallel-planner template", async () => {
      const dir = await makeDir();
      await runScaffold(dir, fakeProvider, "parallel-planner");

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toBe(fakeProvider.dockerfileTemplate);

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain("FAKE_TOKEN=");
    });
  });
});
