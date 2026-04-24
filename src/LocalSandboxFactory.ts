import { Effect, Layer } from "effect";
import { exec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SandboxFactory,
  Sandbox,
  type SandboxInfo,
  type WithSandboxResult,
} from "./SandboxFactory.js";
import type { SandboxError } from "./errors.js";
import type { BranchStrategy } from "./SandboxProvider.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";

const execAsync = promisify(exec);

/**
 * Creates an isolated git global config so that sandbox `git config --global`
 * writes don't corrupt the developer's real ~/.gitconfig.
 */
const createIsolatedGitEnv = (): string => {
  const tmpDir = mkdtempSync(join(tmpdir(), "local-sandbox-gitconfig-"));
  const globalConfigPath = join(tmpDir, ".gitconfig");
  writeFileSync(globalConfigPath, "");
  return globalConfigPath;
};

interface LocalSandboxFactoryOptions {
  readonly branchStrategy: BranchStrategy;
}

/**
 * A SandboxFactory backed by a local tmp directory with `git init`.
 * No Docker, no network. Honours branch strategies using real git.
 */
export const makeLocalSandboxFactoryLayer = (
  options: LocalSandboxFactoryOptions,
): Layer.Layer<SandboxFactory> => {
  const gitConfigGlobal = createIsolatedGitEnv();

  return Layer.succeed(SandboxFactory, {
    withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
      ) => Effect.Effect<A, E, R | Sandbox>,
    ): Effect.Effect<
      WithSandboxResult<A>,
      E | SandboxError,
      Exclude<R, Sandbox>
    > =>
      Effect.acquireUseRelease(
        // Acquire: create tmp dir, git init, seed initial commit, set up branch
        Effect.promise(async () => {
          const sandboxDir = await mkdtemp(
            join(tmpdir(), "local-sandbox-repo-"),
          );
          const gitEnv = {
            ...process.env,
            GIT_CONFIG_GLOBAL: gitConfigGlobal,
          };
          const gitOpts = { cwd: sandboxDir, env: gitEnv };
          await execAsync("git init -b main", gitOpts);
          await execAsync('git config user.email "test@sandcastle.local"', gitOpts);
          await execAsync('git config user.name "Sandcastle Test"', gitOpts);
          await writeFile(join(sandboxDir, ".gitkeep"), "");
          // Seed a minimal package.json so that template hooks like
          // onSandboxReady: [{ command: "npm install" }] don't fail
          // in the bare test repo.
          await writeFile(
            join(sandboxDir, "package.json"),
            '{ "name": "test-sandbox", "private": true }\n',
          );
          await execAsync("git add .gitkeep package.json", gitOpts);
          await execAsync('git commit -m "initial commit"', gitOpts);

          // Set up worktree / branch per strategy
          let workDir = sandboxDir;

          if (options.branchStrategy.type === "merge-to-head") {
            const branch = `sandcastle/test-${Date.now()}`;
            const worktreeDir = await mkdtemp(
              join(tmpdir(), "local-sandbox-worktree-"),
            );
            await execAsync(
              `git worktree add -b "${branch}" "${worktreeDir}" HEAD`,
              gitOpts,
            );
            workDir = worktreeDir;
          } else if (options.branchStrategy.type === "branch") {
            const branch = options.branchStrategy.branch;
            const worktreeDir = await mkdtemp(
              join(tmpdir(), "local-sandbox-worktree-"),
            );
            // Try to check out existing branch, else create new
            try {
              await execAsync(
                `git worktree add "${worktreeDir}" "${branch}"`,
                gitOpts,
              );
            } catch {
              await execAsync(
                `git worktree add -b "${branch}" "${worktreeDir}" HEAD`,
                gitOpts,
              );
            }
            workDir = worktreeDir;
          }

          return { sandboxDir, workDir };
        }),
        // Use
        ({ workDir }) => {
          const sandboxLayer = makeLocalSandboxLayer(workDir);
          return makeEffect({
            hostWorktreePath: workDir,
            sandboxRepoPath: workDir,
            applyToHost: () => Effect.void,
          }).pipe(Effect.provide(sandboxLayer)) as Effect.Effect<
            A,
            E | SandboxError,
            Exclude<R, Sandbox>
          >;
        },
        // Release
        ({ sandboxDir, workDir }) =>
          Effect.promise(async () => {
            // Clean up worktree if separate from sandboxDir
            if (workDir !== sandboxDir) {
              try {
                await execAsync(
                  `git worktree remove --force "${workDir}"`,
                  { cwd: sandboxDir },
                );
              } catch {}
              try {
                await rm(workDir, { recursive: true, force: true });
              } catch {}
            }
            try {
              await rm(sandboxDir, { recursive: true, force: true });
            } catch {}
          }),
      ).pipe(
        Effect.map((value) => ({ value, preservedWorktreePath: undefined })),
      ),
  });
};
