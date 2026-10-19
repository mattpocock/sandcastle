import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitMounts } from "./SandboxFactory.js";

describe("resolveGitMounts", () => {
  const dirs: string[] = [];

  const makeTempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-mount-test-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  const run = (gitPath: string) =>
    Effect.runPromise(
      resolveGitMounts(gitPath).pipe(Effect.provide(NodeFileSystem.layer)),
    );

  it("returns single mount when .git is a directory", async () => {
    const repoDir = await makeTempDir();
    const gitDir = join(repoDir, ".git");
    await mkdir(gitDir);

    const mounts = await run(gitDir);

    expect(mounts).toEqual([{ hostPath: gitDir, sandboxPath: gitDir }]);
  });

  it("mounts only shared metadata when .git is a worktree file", async () => {
    const parentRepoDir = await makeTempDir();
    const parentGitDir = join(parentRepoDir, ".git");
    await mkdir(parentGitDir);
    await mkdir(join(parentGitDir, "worktrees", "my-worktree"), {
      recursive: true,
    });

    const worktreeDir = await makeTempDir();
    const gitFile = join(worktreeDir, ".git");
    await writeFile(gitFile, `gitdir: ${parentGitDir}/worktrees/my-worktree\n`);

    const mounts = await run(gitFile);

    expect(mounts).toEqual([
      { hostPath: parentGitDir, sandboxPath: parentGitDir },
    ]);
  });

  it("falls back to single mount when .git file has unexpected content", async () => {
    const dir = await makeTempDir();
    const gitFile = join(dir, ".git");
    await writeFile(gitFile, "something unexpected\n");

    const mounts = await run(gitFile);

    expect(mounts).toEqual([{ hostPath: gitFile, sandboxPath: gitFile }]);
  });
});
