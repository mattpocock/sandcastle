import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Ref } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandbox, createSandboxFromWorktree } from "./createSandbox.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import {
  PARENT_GIT_SANDBOX_DIR,
  processFileMountParents,
} from "./mountUtils.js";
import {
  SANDBOX_REPO_DIR,
  SandboxConfig,
  SandboxFactory,
  WorktreeDockerSandboxFactory,
} from "./SandboxFactory.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";

const patchPlatform = vi.hoisted(() => ({ value: "linux" }));

// Exercise the real patcher with both platform branches and real Git files.
// Only the platform selection is overridden; no Docker daemon is required.
vi.mock("./mountUtils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mountUtils.js")>();
  return {
    ...actual,
    patchGitMountsForWindows: (
      mounts: Array<{ hostPath: string; sandboxPath: string }>,
      worktreePath: string,
      sandboxRepoDir: string,
    ) =>
      actual.patchGitMountsForWindows(
        mounts,
        worktreePath,
        sandboxRepoDir,
        undefined,
        undefined,
        patchPlatform.value,
      ),
  };
});

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

describe.each(["linux", "win32"])(
  "linked worktree mounts (%s patching)",
  (platform) => {
    let root: string;
    let mainRepo: string;
    let linkedRepo: string;
    let sourceGitFile: string;
    let sourceHead: string;
    const overrideDirs = new Set<string>();

    beforeEach(async () => {
      patchPlatform.value = platform;
      root = await realpath(await mkdtemp(join(tmpdir(), "linked-mounts-")));
      mainRepo = join(root, "main clone");
      linkedRepo = join(root, "linked checkout");
      await mkdir(mainRepo);
      await git(mainRepo, "init", "-b", "main");
      await git(mainRepo, "config", "user.email", "test@example.com");
      await git(mainRepo, "config", "user.name", "Test");
      await writeFile(join(mainRepo, ".gitignore"), ".sandcastle/\n");
      await git(mainRepo, "add", ".gitignore");
      await git(mainRepo, "commit", "-m", "initial");
      await git(mainRepo, "worktree", "add", "-b", "feature", linkedRepo);
      await git(linkedRepo, "commit", "--allow-empty", "-m", "feature work");
      sourceGitFile = await readFile(join(linkedRepo, ".git"), "utf8");
      sourceHead = await git(linkedRepo, "rev-parse", "HEAD");
    });

    afterEach(async () => {
      await Promise.all(
        [root, ...overrideDirs]
          .filter(Boolean)
          .map((dir) => rm(dir, { recursive: true, force: true })),
      );
      overrideDirs.clear();
    });

    it.each([
      "createSandbox",
      "createSandboxFromWorktree",
      "factory branch",
      "factory head",
    ])(
      "%s mounts only the active workspace and shared Git metadata",
      async (entryPoint) => {
        let created = false;
        const provider = createBindMountSandboxProvider({
          name: "validate-linked-mounts",
          create: async (options) => {
            created = true;
            const workspace = options.mounts.find(
              (m) => m.sandboxPath === SANDBOX_REPO_DIR,
            )!;
            const overlay = options.mounts.find(
              (m) => m.sandboxPath === `${SANDBOX_REPO_DIR}/.git`,
            );
            if (
              overlay &&
              basename(dirname(overlay.hostPath)).startsWith("sandcastle-git-")
            ) {
              overrideDirs.add(dirname(overlay.hostPath));
            }

            // Apply the same file-mount validation used by Docker and Podman.
            // A redundant host .git pointer mount fails here on Linux as well.
            expect(
              processFileMountParents(options.mounts, "/home/agent"),
            ).toEqual(platform === "win32" ? [SANDBOX_REPO_DIR] : []);
            expect(
              options.mounts.some(
                (m) => m.hostPath === join(linkedRepo, ".git"),
              ),
            ).toBe(false);
            expect(await git(workspace.hostPath, "rev-parse", "HEAD")).toBe(
              sourceHead,
            );

            const metadata = options.mounts.find(
              (m) => m.hostPath === join(mainRepo, ".git"),
            );
            expect(metadata?.sandboxPath).toBe(
              platform === "win32"
                ? PARENT_GIT_SANDBOX_DIR
                : join(mainRepo, ".git"),
            );
            if (platform === "win32") {
              expect(overlay).toBeDefined();
              const pointer = await readFile(
                join(workspace.hostPath, ".git"),
                "utf8",
              );
              const worktreeName = basename(pointer.trim().replace(/\\/g, "/"));
              expect(await readFile(overlay!.hostPath, "utf8")).toBe(
                `gitdir: ${PARENT_GIT_SANDBOX_DIR}/worktrees/${worktreeName}\n`,
              );
            } else {
              expect(overlay).toBeUndefined();
            }
            expect(options.mounts).toHaveLength(platform === "win32" ? 3 : 2);

            return {
              worktreePath: SANDBOX_REPO_DIR,
              exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
              copyFileIn: async () => {},
              copyFileOut: async () => {},
              close: async () => {},
            };
          },
        });

        if (entryPoint === "createSandbox") {
          const sandbox = await createSandbox({
            cwd: linkedRepo,
            branch: "sandbox-work",
            sandbox: provider,
          });
          await sandbox.close();
        } else if (entryPoint === "createSandboxFromWorktree") {
          const worktreePath = join(root, "existing sandbox");
          await git(
            linkedRepo,
            "worktree",
            "add",
            "-b",
            "sandbox-work",
            worktreePath,
          );
          const sandbox = await createSandboxFromWorktree({
            worktreePath,
            branch: "sandbox-work",
            hostRepoDir: linkedRepo,
            sandbox: provider,
          });
          await sandbox.close();
        } else {
          const layer = Layer.provide(
            WorktreeDockerSandboxFactory.layer,
            Layer.mergeAll(
              Layer.succeed(SandboxConfig, {
                hostRepoDir: linkedRepo,
                env: {},
                sandboxProvider: provider,
                branchStrategy:
                  entryPoint === "factory head"
                    ? { type: "head" }
                    : { type: "branch", branch: "sandbox-work" },
              }),
              NodeFileSystem.layer,
              SilentDisplay.layer(
                Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
              ),
            ),
          );
          await Effect.runPromise(
            Effect.gen(function* () {
              const factory = yield* SandboxFactory;
              yield* factory.withSandbox(() => Effect.void);
            }).pipe(Effect.provide(layer)),
          );
        }

        expect(created).toBe(true);
        expect(await readFile(join(linkedRepo, ".git"), "utf8")).toBe(
          sourceGitFile,
        );
        expect(await git(linkedRepo, "rev-parse", "HEAD")).toBe(sourceHead);
        expect(await git(linkedRepo, "status", "--porcelain")).toBe("");
      },
    );
  },
);
