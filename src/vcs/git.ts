import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import type { VersionControlProvider } from "../VersionControl.js";
import * as WorktreeManager from "../WorktreeManager.js";
import { resolveGitMounts } from "../SandboxFactory.js";

const execFileAsync = promisify(execFile);

export const shellSingleQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export const git = (): VersionControlProvider => ({
  tag: "git",

  // ----- Checkout lifecycle -----
  createCheckout: async ({ repoDir, branch, baseBranch }) => {
    const info = await Effect.runPromise(
      WorktreeManager.create(repoDir, { branch, baseBranch }).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );
    return { path: info.path, branch: info.branch };
  },

  removeCheckout: async (checkoutPath) => {
    await Effect.runPromise(WorktreeManager.remove(checkoutPath));
  },

  pruneStaleCheckouts: async (repoDir) => {
    await Effect.runPromise(
      WorktreeManager.pruneStale(repoDir).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  },

  hasUncommittedChanges: async (checkoutPath) => {
    return Effect.runPromise(
      WorktreeManager.hasUncommittedChanges(checkoutPath),
    );
  },

  // ----- Repo introspection -----
  currentBranch: async (repoDir) => {
    return Effect.runPromise(WorktreeManager.getCurrentBranch(repoDir));
  },

  headRef: async (repoDir) => {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
    });
    return result.stdout.trim();
  },

  commitsBetween: async (repoDir, base, head) => {
    const result = await execFileAsync(
      "git",
      ["rev-list", `${base}..${head}`],
      { cwd: repoDir },
    );
    return result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((id) => ({ id: id.trim() }));
  },

  // ----- Identity -----
  readUserIdentity: async (repoDir) => {
    const [name, email] = await Promise.all([
      execFileAsync("git", ["config", "user.name"], { cwd: repoDir })
        .then((r) => r.stdout.trim())
        .catch(() => ""),
      execFileAsync("git", ["config", "user.email"], { cwd: repoDir })
        .then((r) => r.stdout.trim())
        .catch(() => ""),
    ]);
    return { name, email };
  },

  writeUserIdentityCommands: ({ name, email }) => {
    const cmds: string[] = [];
    if (name)
      cmds.push(`git config --global user.name ${shellSingleQuote(name)}`);
    if (email)
      cmds.push(`git config --global user.email ${shellSingleQuote(email)}`);
    return cmds;
  },

  // ----- Transport -----
  bundleAllRefs: async (repoDir, outBundlePath) => {
    await execFileAsync("git", ["bundle", "create", outBundlePath, "--all"], {
      cwd: repoDir,
    });
  },

  // cloneFromBundleCommands returns multiple commands rather than chaining with
  // && because the existing syncIn.ts flow runs them as separate handle.exec
  // calls. Preserving that boundary keeps step-level error reporting intact.
  cloneFromBundleCommands: ({ bundlePath, targetPath, branch }) => {
    const sq = shellSingleQuote;
    return [
      `git clone ${sq(bundlePath)} ${sq(targetPath + "_clone")}`,
      `rm -rf ${sq(targetPath)} && mv ${sq(targetPath + "_clone")} ${sq(targetPath)}`,
      `cd ${sq(targetPath)} && git checkout ${sq(branch)}`,
    ];
  },

  exportPatchesCommand: ({ base, outDir }) => {
    const sq = shellSingleQuote;
    return `git format-patch ${sq(base + "..HEAD")} -o ${sq(outDir)}`;
  },

  diffWorkingTreeCommand: () => `git diff HEAD`,

  applyPatchCommand: ({ patchPath }) =>
    `git apply ${shellSingleQuote(patchPath)}`,

  listUntrackedCommand: () => `git ls-files --others --exclude-standard`,

  // ----- Merge-back -----
  detachCheckout: async (checkoutPath) => {
    await execFileAsync("git", ["checkout", "--detach"], {
      cwd: checkoutPath,
    });
  },

  mergeBranchInto: async ({
    repoDir,
    sourceBranch,
    targetBranch: _targetBranch,
  }) => {
    await execFileAsync("git", ["merge", sourceBranch], { cwd: repoDir });
  },

  deleteBranch: async (repoDir, branch) => {
    await execFileAsync("git", ["branch", "-D", branch], { cwd: repoDir });
  },

  // ----- Mounts -----
  // checkoutPath is unused for git (will matter for jj); accepted now to keep
  // the signature stable across providers.
  resolveRepoMounts: async ({ gitPath }) => {
    const mounts = await Effect.runPromise(
      resolveGitMounts(gitPath).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    return mounts.map((m) => ({
      hostPath: m.hostPath,
      sandboxPath: m.sandboxPath,
    }));
  },

  mergeFailureHint: ({ sourceBranch, targetBranch: _targetBranch }) =>
    `To retry: git merge ${sourceBranch}, then clean up: git branch -D ${sourceBranch}`,

  // ----- Recovery instructions -----
  recoveryInstructions: ({ patchDir, targetBranch }) => {
    const sq = shellSingleQuote;
    const lines: string[] = [
      `git checkout ${sq(targetBranch)}`,
      `git am --3way ${sq(patchDir)}/*.patch`,
      `git apply ${sq(patchDir)}/changes.patch`,
    ];
    return lines.join("\n");
  },
});
