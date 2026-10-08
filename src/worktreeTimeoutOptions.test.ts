import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import { createSandbox } from "./createSandbox.js";
import { createWorktree } from "./createWorktree.js";
import { WorktreeTimeoutError } from "./errors.js";
import { interactive } from "./interactive.js";
import { run, type Timeouts } from "./run.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import * as WorktreeManager from "./WorktreeManager.js";

const execFileAsync = promisify(execFile);
const agent = claudeCode("test-model");
const provider = createBindMountSandboxProvider({
  name: "must-not-start",
  create: async () => {
    throw new Error("Sandbox must not start after worktree creation times out");
  },
});

describe("public worktree timeout options", () => {
  let cwd: string;
  let observedPruneTimeout: number | undefined;

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "worktree-timeouts-")));
    await execFileAsync("git", ["init", "-b", "main"], { cwd });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], {
      cwd,
    });
    observedPruneTimeout = undefined;

    // Fail at the Git operation boundary, before any agent/container starts.
    // Prune remains best-effort, so its failure must still reach creation.
    vi.spyOn(WorktreeManager, "pruneStale").mockImplementation(
      (repoDir, timeoutMs = 30_000) => {
        observedPruneTimeout = timeoutMs;
        return Effect.fail(
          new WorktreeTimeoutError({
            message: `Worktree prune timed out after ${timeoutMs}ms`,
            timeoutMs,
            path: repoDir,
            operation: "prune",
          }),
        );
      },
    );
    vi.spyOn(WorktreeManager, "create").mockImplementation(
      (repoDir, _opts, timeoutMs = 30_000) =>
        Effect.fail(
          new WorktreeTimeoutError({
            message: `Worktree creation timed out after ${timeoutMs}ms`,
            timeoutMs,
            path: repoDir,
            operation: "create",
          }),
        ),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  const entryPoints: Array<{
    name: string;
    start: (timeouts?: Timeouts) => Promise<unknown>;
  }> = [
    {
      name: "createSandbox",
      start: (timeouts) =>
        createSandbox({ cwd, branch: "feature", sandbox: provider, timeouts }),
    },
    ...(["branch", "merge-to-head"] as const).flatMap((type) => {
      const branchStrategy =
        type === "branch" ? { type, branch: "feature" } : { type };
      return [
        {
          name: `createWorktree (${type})`,
          start: (timeouts?: Timeouts) =>
            createWorktree({ cwd, branchStrategy, timeouts }),
        },
        {
          name: `interactive (${type})`,
          start: (timeouts?: Timeouts) =>
            interactive({
              cwd,
              branchStrategy,
              timeouts,
              agent,
              sandbox: provider,
              prompt: "test",
            }),
        },
        {
          name: `run (${type})`,
          start: (timeouts?: Timeouts) =>
            run({
              cwd,
              branchStrategy,
              timeouts,
              agent,
              sandbox: provider,
              prompt: "test",
              logging: { type: "stdout" },
            }),
        },
      ];
    }),
  ];

  describe.each(entryPoints)("$name", ({ start }) => {
    it.each([
      { name: "defaults", timeouts: undefined },
      {
        name: "overrides",
        timeouts: { worktreeCreateMs: 120_000, worktreePruneMs: 90_000 },
      },
    ])(
      "preserves timeout errors and best-effort pruning with $name",
      async ({ timeouts }) => {
        await expect(start(timeouts)).rejects.toThrow(
          `Worktree creation timed out after ${timeouts?.worktreeCreateMs ?? 30_000}ms`,
        );
        expect(observedPruneTimeout).toBe(timeouts?.worktreePruneMs ?? 30_000);
      },
    );
  });
});
