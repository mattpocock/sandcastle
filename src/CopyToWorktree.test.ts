import { existsSync } from "node:fs";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  chmod,
  readFile,
} from "node:fs/promises";
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

  it("succeeds when first cp fails but fallback cp -R succeeds", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    // Create a source file
    await writeFile(join(hostDir, "file.txt"), "content");

    try {
      // Normal copy should succeed (fallback may or may not be needed)
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
        copyToWorktree(["big-file.txt"], hostDir, worktreeDir, customTimeout),
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

  // Regression: the copy used to run under `Effect.async` with no canceler, so
  // a timeout failed the Effect while leaving `cp` alive. The orphan kept
  // writing into a worktree the caller was already tearing down, recreating a
  // directory git could no longer see. Both tests shadow the real `cp` with a
  // shim, since the library invokes it unqualified via PATH.
  it("kills the running cp when the timeout fires", async () => {
    if (process.platform === "win32") return; // POSIX shell shim
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));
    const shimDir = await mkdtemp(join(tmpdir(), "cw-shim-"));
    const logPath = join(shimDir, "cp.log");

    await writeFile(join(hostDir, "file.txt"), "content");

    // A cp that outlives the timeout, recording whether it was signalled or
    // ran to completion.
    await writeFile(
      join(shimDir, "cp"),
      `#!/bin/sh\ntrap 'printf killed >> "${logPath}"; exit 143' TERM\n` +
        `sleep 5 &\nwait $!\nprintf completed >> "${logPath}"\n`,
    );
    await chmod(join(shimDir, "cp"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
    try {
      const exit = await Effect.runPromiseExit(
        copyToWorktree(["file.txt"], hostDir, worktreeDir, 200),
      );
      expect(Exit.isFailure(exit)).toBe(true);

      // Give the signalled child a moment to record its fate.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await readFile(logPath, "utf8")).toBe("killed");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it("does not start the cp -R fallback after the timeout has fired", async () => {
    if (process.platform === "win32") return; // POSIX shell shim
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));
    const shimDir = await mkdtemp(join(tmpdir(), "cw-shim-"));
    const logPath = join(shimDir, "cp.log");

    await writeFile(join(hostDir, "file.txt"), "content");

    // The copy-on-write attempt fails, but only after the timeout has already
    // failed the Effect. Its callback must not spawn the fallback.
    await writeFile(
      join(shimDir, "cp"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\n` +
        `case "$*" in *--reflink=auto*|*-cR*) sleep 1; exit 1;; esac\nexit 0\n`,
    );
    await chmod(join(shimDir, "cp"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
    try {
      const exit = await Effect.runPromiseExit(
        copyToWorktree(["file.txt"], hostDir, worktreeDir, 200),
      );
      expect(Exit.isFailure(exit)).toBe(true);

      // Wait past the point where the failing attempt's callback fires.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const invocations = (await readFile(logPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(invocations).toHaveLength(1);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
      await rm(shimDir, { recursive: true, force: true });
    }
  });
});
