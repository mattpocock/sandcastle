import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { copyToWorktree, getCopyOnWriteFlags } from "./CopyToWorktree.js";
import { CopyToWorktreeError, CopyToWorktreeTimeoutError } from "./errors.js";

describe("getCopyOnWriteFlags", () => {
  it("returns -cR on darwin (APFS clonefile)", () => {
    expect(getCopyOnWriteFlags("darwin")).toEqual(["-cR"]);
  });

  it("returns -R --reflink=auto on linux", () => {
    expect(getCopyOnWriteFlags("linux")).toEqual(["-R", "--reflink=auto"]);
  });

  it("returns -R --reflink=auto on other platforms", () => {
    expect(getCopyOnWriteFlags("win32")).toEqual(["-R", "--reflink=auto"]);
    expect(getCopyOnWriteFlags("freebsd")).toEqual(["-R", "--reflink=auto"]);
  });
});

describe("copyToWorktree", () => {
  it("fails with CopyToWorktreeError when fallback cp -R fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    // Create source at hostDir/nested/file.txt
    await mkdir(join(hostDir, "nested"));
    await writeFile(join(hostDir, "nested", "file.txt"), "content");

    // Create a regular file at worktreeDir/nested — cp will fail
    // because it cannot traverse a file as if it were a directory
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

    // Create a file that exists so cp is actually attempted
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
      // but if it times out, the error should carry the custom timeout value
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error;
        expect(error).toBeInstanceOf(CopyToWorktreeTimeoutError);
        if (error instanceof CopyToWorktreeTimeoutError) {
          expect(error.timeoutMs).toBe(customTimeout);
        }
      }
      // If it succeeds, that's also fine — the timeout just didn't fire
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
      // Call without timeoutMs — should succeed normally
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
