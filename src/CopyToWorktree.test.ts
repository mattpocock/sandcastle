import { existsSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { copyToWorktree } from "./CopyToWorktree.js";
import { CopyToWorktreeError, CopyToWorktreeTimeoutError } from "./errors.js";

// Symlink creation on Windows requires Developer Mode or admin. The kit
// requires Developer Mode (see CLAUDE.md), but skip the symlink-preservation
// test if creation is unavailable so the suite stays portable.
const symlinkSupported = await (async () => {
  const probe = await mkdtemp(join(tmpdir(), "cw-sym-probe-"));
  try {
    await writeFile(join(probe, "target.txt"), "x");
    await symlink("target.txt", join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
})();

describe("copyToWorktree", () => {
  it("fails with CopyToWorktreeError when the destination parent is a file", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    // Create source at hostDir/nested/file.txt
    await mkdir(join(hostDir, "nested"));
    await writeFile(join(hostDir, "nested", "file.txt"), "content");

    // Create a regular file at worktreeDir/nested — the copy will fail
    // because dest's parent is a file, not a directory.
    await writeFile(join(worktreeDir, "nested"), "blocker");

    try {
      const exit = await Effect.runPromiseExit(
        copyToWorktree(["nested/file.txt"], hostDir, worktreeDir),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error;
        expect(error).toBeInstanceOf(CopyToWorktreeError);
        if (error instanceof CopyToWorktreeError) {
          expect(error.path).toBe("nested/file.txt");
          expect(error.stderr).toBeTruthy();
          expect(error._tag).toBe("CopyToWorktreeError");
        }
      } else {
        throw new Error("Expected Fail cause");
      }
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("copies a regular file", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    await writeFile(join(hostDir, "file.txt"), "content");

    try {
      await Effect.runPromise(
        copyToWorktree(["file.txt"], hostDir, worktreeDir),
      );
      expect(existsSync(join(worktreeDir, "file.txt"))).toBe(true);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("recursively copies a directory tree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    await mkdir(join(hostDir, "pkg", "sub"), { recursive: true });
    await writeFile(join(hostDir, "pkg", "a.txt"), "A");
    await writeFile(join(hostDir, "pkg", "sub", "b.txt"), "B");

    try {
      await Effect.runPromise(copyToWorktree(["pkg"], hostDir, worktreeDir));

      expect(existsSync(join(worktreeDir, "pkg", "a.txt"))).toBe(true);
      expect(existsSync(join(worktreeDir, "pkg", "sub", "b.txt"))).toBe(true);
      // The bug we previously hit nested the source inside an existing dest;
      // a second-level node_modules/node_modules path must not appear here.
      expect(existsSync(join(worktreeDir, "pkg", "pkg"))).toBe(false);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("does not nest when the destination directory already exists", async () => {
    // Regression: previously, after a partial cp + failed fs.rm cleanup, the
    // fallback `cp -R src dest` would copy src INSIDE dest (POSIX semantics),
    // producing `node_modules/node_modules/...`. The Node-based walk merges
    // into existing directories instead.
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    await mkdir(join(hostDir, "tree"));
    await writeFile(join(hostDir, "tree", "fresh.txt"), "fresh");

    // Pre-existing destination directory with stale content
    await mkdir(join(worktreeDir, "tree"));
    await writeFile(join(worktreeDir, "tree", "stale.txt"), "stale");

    try {
      await Effect.runPromise(copyToWorktree(["tree"], hostDir, worktreeDir));

      expect(existsSync(join(worktreeDir, "tree", "fresh.txt"))).toBe(true);
      // No nesting
      expect(existsSync(join(worktreeDir, "tree", "tree"))).toBe(false);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!symlinkSupported)(
    "preserves symlinks with their original (relative) target",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
      const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

      await mkdir(join(hostDir, "pkg", "bin"), { recursive: true });
      await writeFile(join(hostDir, "pkg", "bin", "real"), "binary");
      // .bin/shim → ../bin/real, mirroring the node_modules/.bin layout
      await mkdir(join(hostDir, "pkg", ".bin"));
      await symlink("../bin/real", join(hostDir, "pkg", ".bin", "shim"));

      const srcLink = join(hostDir, "pkg", ".bin", "shim");
      const expectedTarget = await readlink(srcLink);
      // Sanity-check the source link is RELATIVE (would be absolutised by
      // some copy strategies — that is the bug we're guarding against).
      expect(expectedTarget.startsWith("..")).toBe(true);

      try {
        await Effect.runPromise(copyToWorktree(["pkg"], hostDir, worktreeDir));

        const copiedLink = join(worktreeDir, "pkg", ".bin", "shim");
        const lst = await lstat(copiedLink);
        expect(lst.isSymbolicLink()).toBe(true);
        // The dest symlink must carry the same target as the source —
        // not absolutised, not rewritten.
        expect(await readlink(copiedLink)).toBe(expectedTarget);
      } finally {
        await rm(hostDir, { recursive: true, force: true });
        await rm(worktreeDir, { recursive: true, force: true });
      }
    },
  );

  it("skips missing source paths without error", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    try {
      await Effect.runPromise(
        copyToWorktree(["nonexistent.txt"], hostDir, worktreeDir),
      );
      // Should complete without error
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("uses custom timeoutMs when provided", async () => {
    vi.useFakeTimers();
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    // Create a file that exists so the copy is actually attempted
    await writeFile(join(hostDir, "big-file.txt"), "content");

    try {
      const customTimeout = 500;
      const exitPromise = Effect.runPromiseExit(
        copyToWorktree(
          ["big-file.txt"],
          hostDir,
          worktreeDir,
          customTimeout,
        ),
      );

      // Advance past the custom timeout
      await vi.advanceTimersByTimeAsync(customTimeout + 100);

      const exit = await exitPromise;
      // The copy may succeed before the timeout fires on fast systems,
      // but if it times out, the error must carry the custom timeout value.
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error;
        expect(error).toBeInstanceOf(CopyToWorktreeTimeoutError);
        if (error instanceof CopyToWorktreeTimeoutError) {
          expect(error.timeoutMs).toBe(customTimeout);
        }
      }
    } finally {
      vi.useRealTimers();
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("defaults to 60s timeout when timeoutMs is omitted", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    await writeFile(join(hostDir, "file.txt"), "content");

    try {
      await Effect.runPromise(
        copyToWorktree(["file.txt"], hostDir, worktreeDir),
      );
      expect(existsSync(join(worktreeDir, "file.txt"))).toBe(true);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });
});
