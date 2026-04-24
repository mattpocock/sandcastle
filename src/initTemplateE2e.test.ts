/**
 * E2E tests for init templates — scaffolds the template, dynamically imports
 * the generated main.mts with @ai-hero/sandcastle aliased (via vitest.config.ts)
 * to the internal testSupport module, and asserts the recorded agent invocations.
 *
 * No Docker, no real agent, no network.
 */
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scaffold,
  getAgent,
  getBacklogManager,
  listAgents,
  listBacklogManagers,
} from "./InitService.js";
import {
  clearRecordedInvocations,
  getRecordedInvocations,
} from "./testSupport.js";

const execAsync = promisify(exec);

describe("init-template e2e", () => {
  let scaffoldDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    scaffoldDir = await mkdtemp(join(tmpdir(), "init-template-e2e-"));

    // Create a git repo in the scaffold dir so that branch resolution works
    await execAsync("git init -b main", { cwd: scaffoldDir });
    await execAsync('git config user.email "test@sandcastle.local"', {
      cwd: scaffoldDir,
    });
    await execAsync('git config user.name "Sandcastle Test"', {
      cwd: scaffoldDir,
    });
    // Need at least one commit for git branch operations
    await execAsync("git commit --allow-empty -m 'initial commit'", {
      cwd: scaffoldDir,
    });

    clearRecordedInvocations();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    try {
      await rm(scaffoldDir, { recursive: true, force: true });
    } catch {}
  });

  describe("blank template", () => {
    it("scaffolds and executes with claudeCode agent, github-issues backlog manager", async () => {
      const agent = getAgent("claude-code")!;
      const backlogManager = getBacklogManager("github-issues")!;

      // Scaffold the blank template
      const result = await Effect.runPromise(
        scaffold(scaffoldDir, {
          agent,
          model: "claude-opus-4-6",
          templateName: "blank",
          createLabel: true,
          backlogManager,
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );

      // Verify the main file was created
      const mainFilePath = join(
        scaffoldDir,
        ".sandcastle",
        result.mainFilename,
      );
      const mainContent = await readFile(mainFilePath, "utf-8");
      expect(mainContent).toContain("run");
      expect(mainContent).toContain("claudeCode");

      // Read the expected prompt content
      const promptPath = join(scaffoldDir, ".sandcastle", "prompt.md");
      const expectedPrompt = await readFile(promptPath, "utf-8");

      // chdir to the scaffold dir so relative prompt file paths resolve
      process.chdir(scaffoldDir);

      // Dynamically import the scaffolded main file.
      // The vitest alias rewrites @ai-hero/sandcastle → testSupport.ts
      // which exports runForTest as run, so the template runs unchanged.
      await import(mainFilePath);

      // Assert the recorded invocation
      const invocations = getRecordedInvocations();
      expect(invocations).toHaveLength(1);

      const invocation = invocations[0]!;
      expect(invocation.agentProvider).toBe("claude-code");
      expect(invocation.model).toBe("claude-opus-4-6");
      expect(invocation.prompt).toBe(expectedPrompt);
      expect(invocation.branchStrategy).toEqual({ type: "head" });
      expect(invocation.maxIterations).toBe(1);
      expect(invocation.iterationIndex).toBe(1);
    });
  });

  describe("simple-loop template", () => {
    const agents = listAgents();
    const backlogManagers = listBacklogManagers();

    const combinations = agents.flatMap((agent) =>
      backlogManagers.map((bm) => ({
        agentName: agent.name,
        bmName: bm.name,
      })),
    );

    /** Shell expression substrings expected per backlog manager. */
    const shellExpressionsByBm: Record<string, string[]> = {
      "github-issues": ["gh issue list", "gh issue close"],
      beads: ["bd ready", "bd close"],
    };

    describe.each(combinations)(
      "agent=$agentName, backlog-manager=$bmName",
      ({ agentName, bmName }) => {
        it("scaffolds and executes with iterate-until-COMPLETE wiring", async () => {
          const agent = getAgent(agentName)!;
          const backlogManager = getBacklogManager(bmName)!;

          // Scaffold the simple-loop template
          const result = await Effect.runPromise(
            scaffold(scaffoldDir, {
              agent,
              model: agent.defaultModel,
              templateName: "simple-loop",
              createLabel: true,
              backlogManager,
            }).pipe(Effect.provide(NodeFileSystem.layer)),
          );

          // Read the expected prompt content
          const promptPath = join(scaffoldDir, ".sandcastle", "prompt.md");
          const expectedPrompt = await readFile(promptPath, "utf-8");

          // Assert the prompt contains the backlog-manager's shell expressions
          for (const expr of shellExpressionsByBm[bmName]!) {
            expect(expectedPrompt).toContain(expr);
          }

          // chdir to the scaffold dir so relative prompt file paths resolve
          process.chdir(scaffoldDir);

          // Dynamically import the scaffolded main file.
          const mainFilePath = join(
            scaffoldDir,
            ".sandcastle",
            result.mainFilename,
          );
          await import(mainFilePath);

          // Assert: only one recorded invocation (completion signal stops loop)
          const invocations = getRecordedInvocations();
          expect(invocations).toHaveLength(1);

          const invocation = invocations[0]!;

          // Assert: agent provider matches the --agent choice
          expect(invocation.agentProvider).toBe(agentName);

          // Assert: model matches the agent's defaultModel
          expect(invocation.model).toBe(agent.defaultModel);

          // Assert: recorded prompt matches the scaffolded prompt
          expect(invocation.prompt).toBe(expectedPrompt);

          // Assert: branch strategy from the template (merge-to-head)
          expect(invocation.branchStrategy).toEqual({
            type: "merge-to-head",
          });

          // Assert: maxIterations from the template (3)
          expect(invocation.maxIterations).toBe(3);

          // Assert: only first iteration ran (completion signal on iteration 1)
          expect(invocation.iterationIndex).toBe(1);
        });
      },
    );
  });
});
