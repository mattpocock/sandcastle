#!/usr/bin/env node
/**
 * Fail the pre-commit hook if any staged file also has unstaged edits.
 *
 * The hook runs lint-staged with `--no-stash`, because lint-staged's backup
 * stash lives in `refs/stash`, which every worktree of the repo shares:
 * parallel commits from different worktrees race on it, drop each other's
 * entries and leave stray "lint-staged automatic backup" entries behind.
 *
 * Without the stash, lint-staged can't hide unstaged hunks while prettier
 * runs, so it would format and re-stage them. Refusing partially staged
 * files keeps commits to exactly what was staged.
 */
import { execFileSync } from "node:child_process";

const names = (...args) =>
  execFileSync("git", ["diff", "--name-only", "-z", ...args], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

const unstaged = new Set(names());
const partial = names("--cached", "--diff-filter=ACMR").filter((file) =>
  unstaged.has(file),
);

if (partial.length > 0) {
  console.error(
    [
      "These files have both staged and unstaged changes:",
      ...partial.map((file) => `  ${file}`),
      "",
      "The pre-commit hook formats staged files in place and re-stages them,",
      "so it would commit the unstaged edits too. Stage each file in full",
      "(git add <file>). Don't set the rest aside with `git stash`: the",
      "stash is shared by every worktree of this repo.",
    ].join("\n"),
  );
  process.exit(1);
}
