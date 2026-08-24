import { Effect, Layer, Ref } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type SandboxProvider,
} from "./SandboxProvider.js";
import {
  SandboxConfig,
  SandboxFactory,
  SANDBOX_REPO_DIR,
  WorktreeDockerSandboxFactory,
} from "./SandboxFactory.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const noopProvider = (): SandboxProvider =>
  createBindMountSandboxProvider({
    name: "test-provider",
    create: async () => {
      const handle: BindMountSandboxHandle = {
        worktreePath: SANDBOX_REPO_DIR,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      };
      return handle;
    },
  });

describe("WorktreeDockerSandboxFactory — baseBranch (real git)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("forks new branch from baseBranch when run() goes through SandboxFactory", async () => {
    const hostRepoDir = await mkdtemp(join(tmpdir(), "sandcastle-bb-test-"));
    tempDirs.push(hostRepoDir);
    await initRepo(hostRepoDir);
    await commitFile(hostRepoDir, "init.txt", "init", "initial commit");

    const { stdout: baseSha } = await execAsync("git rev-parse HEAD", {
      cwd: hostRepoDir,
    });
    await commitFile(hostRepoDir, "second.txt", "second", "second commit");

    const childBranch = "sandcastle/child-from-base";
    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          stateDir: join(hostRepoDir, ".sandcastle"),
          sandboxProvider: noopProvider(),
          branchStrategy: {
            type: "branch",
            branch: childBranch,
            baseBranch: baseSha.trim(),
          },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layer)),
    );

    const { stdout: branchSha } = await execAsync(
      `git rev-parse ${childBranch}`,
      { cwd: hostRepoDir },
    );
    expect(branchSha.trim()).toBe(baseSha.trim());
  });
});
