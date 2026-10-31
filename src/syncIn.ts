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
import { hostGit } from "./hostGit.js";

/** Run host git, failing with SyncError on non-zero exit. */
const execHostGit = (
  args: readonly string[],
  cwd: string,
): Effect.Effect<string, SyncError> =>
  hostGit(args, cwd).pipe(
    Effect.mapError(
      (e) =>
        new SyncError({
          message: `Host command failed: git ${args.join(" ")}\n${e.message}`,
        }),
    ),
  );

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
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new SyncError({
              message: `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
            }),
          ),
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
): Effect.Effect<{ branch: string }, SyncError> =>
  Effect.gen(function* () {
    // Get current branch from host
    const branch = (yield* execHostGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      hostRepoDir,
    )).trim();

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
        yield* execHostGit(
          ["bundle", "create", bundleHostPath, "--all"],
          hostRepoDir,
        );

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

        // Clone from bundle into the worktree
        const { worktreePath } = handle;
        yield* execOk(
          handle,
          `git clone "${bundleSandboxPath}" "${worktreePath}_clone"`,
        );

        // Move contents from clone into worktree (git clone requires empty target)
        yield* execOk(
          handle,
          `rm -rf "${worktreePath}" && mv "${worktreePath}_clone" "${worktreePath}"`,
        );

        // Checkout the correct branch
        yield* execOk(handle, `git checkout "${branch}"`, {
          cwd: worktreePath,
        });

        // Clean up sandbox temp files
        yield* Effect.tryPromise({
          try: () => handle.exec(`rm -rf "${sandboxTmpDir}"`),
          catch: () =>
            new SyncError({ message: "Failed to clean up sandbox temp dir" }),
        });

        // Verify sync succeeded
        const hostHead = (yield* execHostGit(
          ["rev-parse", "HEAD"],
          hostRepoDir,
        )).trim();
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
