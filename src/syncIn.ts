/**
 * Sync-in: transfer a host git repo into an isolated sandbox via git bundle.
 *
 * Creates a git bundle capturing all refs from the host repo,
 * copies it into the sandbox via the provider's copyIn, and
 * clones from the bundle inside the sandbox.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { SyncError } from "./errors.js";
import type { VersionControlProvider } from "./VersionControl.js";
import { git } from "./vcs/git.js";

/**
 * Execute a command in the sandbox, failing with SyncError if it exits non-zero.
 */
const execOk = (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<
  { stdout: string; stderr: string; exitCode: number },
  SyncError
> =>
  Effect.tryPromise({
    try: () => handle.exec(command, options),
    catch: (e) =>
      new SyncError({
        message: `Sandbox exec failed: ${command}\n${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            new SyncError({
              message: `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
            }),
          )
        : Effect.succeed(result),
    ),
  );

/**
 * Sync a host git repo into an isolated sandbox.
 *
 * 1. `git bundle create --all` on the host
 * 2. `copyIn` the bundle to the sandbox
 * 3. `git clone` from the bundle inside the sandbox
 * 4. Verify HEAD matches
 *
 * @returns The branch name that was checked out
 */
export const syncIn = (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
  vcsOpt?: VersionControlProvider,
): Effect.Effect<{ branch: string }, SyncError> =>
  Effect.gen(function* () {
    const vcs = vcsOpt ?? git();
    // Get current branch from host
    const branch = yield* Effect.tryPromise({
      try: () => vcs.currentBranch(hostRepoDir),
      catch: (e) =>
        new SyncError({
          message: `Failed to read host branch: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    // Create git bundle on host capturing all refs
    const bundleDir = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "sandcastle-bundle-")),
      catch: (e) =>
        new SyncError({
          message: `Failed to create temp dir: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });
    const bundleHostPath = join(bundleDir, "repo.bundle");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => vcs.bundleAllRefs(hostRepoDir, bundleHostPath),
          catch: (e) =>
            new SyncError({
              message: `Failed to bundle host repo: ${e instanceof Error ? e.message : String(e)}`,
            }),
        });

        // Create temp dir in sandbox and copy bundle in
        const mkTempResult = yield* execOk(
          handle,
          "mktemp -d -t sandcastle-XXXXXX",
        );
        const sandboxTmpDir = mkTempResult.stdout.trim();
        const bundleSandboxPath = `${sandboxTmpDir}/repo.bundle`;

        yield* Effect.tryPromise({
          try: () => handle.copyIn(bundleHostPath, bundleSandboxPath),
          catch: (e) =>
            new SyncError({
              message: `Failed to copy bundle into sandbox: ${e instanceof Error ? e.message : String(e)}`,
            }),
        });

        // Clone from bundle into the worktree.
        // Sandbox-side: agent environment is always git, even when host vcs is
        // jj. Command strings come from vcs.cloneFromBundleCommands so the
        // abstraction owns the strings even though execution is via handle.exec.
        const worktreePath = handle.worktreePath;
        const cloneCmds = vcs.cloneFromBundleCommands({
          bundlePath: bundleSandboxPath,
          targetPath: worktreePath,
          branch,
        });
        // The first two commands need no cwd (operate via absolute paths). The
        // third uses an embedded `cd "${targetPath}"` so a cwd is also unneeded.
        for (const cmd of cloneCmds) {
          yield* execOk(handle, cmd);
        }

        // Clean up sandbox temp files
        yield* Effect.tryPromise({
          try: () => handle.exec(`rm -rf "${sandboxTmpDir}"`),
          catch: () =>
            new SyncError({ message: "Failed to clean up sandbox temp dir" }),
        });

        // Verify sync succeeded
        const hostHead = yield* Effect.tryPromise({
          try: () => vcs.headRef(hostRepoDir),
          catch: (e) =>
            new SyncError({
              message: `Failed to read host HEAD: ${e instanceof Error ? e.message : String(e)}`,
            }),
        });
        // Sandbox-side: agent environment is always git, even when host vcs is jj.
        const sandboxHead = (yield* execOk(handle, "git rev-parse HEAD", {
          cwd: worktreePath,
        })).stdout.trim();

        if (hostHead !== sandboxHead) {
          yield* Effect.fail(
            new SyncError({
              message: `HEAD mismatch after sync-in: host=${hostHead} sandbox=${sandboxHead}`,
            }),
          );
        }
      }),
      // Clean up host-side bundle temp dir (runs regardless of success/failure)
      Effect.promise(() => rm(bundleDir, { recursive: true, force: true })),
    );

    return { branch };
  });
