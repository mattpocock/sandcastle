#!/usr/bin/env tsx
/**
 * Factory implementer entry point.
 *
 * The factory daemon spawns this script once per task with the following
 * environment variables populated:
 *
 *   FACTORY_REPO_PATH           Absolute path to the managed repo (also cwd).
 *   FACTORY_BRANCH              Branch name the task must commit onto.
 *   FACTORY_BASE                Base ref the branch is stacked on
 *                               (e.g. "origin/main" or "origin/<parent>").
 *   FACTORY_TASK_ID             Stable task identifier from the plan.
 *   FACTORY_TASK_DESCRIPTION    Human-readable task description.
 *   FACTORY_TASK_ISSUE_NUMBER   GitHub issue number the task is linked to.
 *                               Required: both prompts fill {{ISSUE_NUMBER}}.
 *
 * Exit 0 on success, non-zero on failure. Stdout/stderr are inherited by
 * the daemon. Commits landed on FACTORY_BRANCH will be pushed and opened
 * as a PR automatically.
 */
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

/** Read an env var the daemon always sets; fail fast if it is missing. */
const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`implement-task: ${name} is not set`);
  }
  return value;
};

const branch = requireEnv("FACTORY_BRANCH");
const base = process.env["FACTORY_BASE"];
const repoPath = process.env["FACTORY_REPO_PATH"];
const taskDescription = requireEnv("FACTORY_TASK_DESCRIPTION");
const issueNumber = requireEnv("FACTORY_TASK_ISSUE_NUMBER");

await using worktree = await sandcastle.createWorktree({
  cwd: repoPath,
  branchStrategy: {
    type: "branch",
    branch,
    baseBranch: base,
  },
  copyToWorktree: ["node_modules"],
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "npm install && npm run build" }],
    },
  },
});

await using sandbox = await worktree.createSandbox({
  sandbox: docker(),
});

const result = await sandbox.run({
  name: `Implementer #${issueNumber}`,
  agent: sandcastle.claudeCode("claude-opus-4-8"),
  promptFile: "./.sandcastle/implement-prompt.md",
  promptArgs: {
    ISSUE_NUMBER: issueNumber,
    ISSUE_TITLE: taskDescription,
    BRANCH: branch,
  },
});

if (result.commits.length > 0) {
  await sandbox.run({
    name: `Reviewer #${issueNumber}`,
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/review-prompt.md",
    promptArgs: {
      ISSUE_NUMBER: issueNumber,
      ISSUE_TITLE: taskDescription,
      BRANCH: branch,
    },
  });
}
