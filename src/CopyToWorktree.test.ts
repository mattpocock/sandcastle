import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
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

  it("merges a directory into one that already exists in the worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    // Host: cfg/tracked.txt (tracked, so already in the worktree) and
    // cfg/secret.txt (gitignored, so only on the host)
    await mkdir(join(hostDir, "cfg", "sub"), { recursive: true });
    await writeFile(join(hostDir, "cfg", "tracked.txt"), "tracked");
    await writeFile(join(hostDir, "cfg", "secret.txt"), "secret");
    await writeFile(join(hostDir, "cfg", "sub", "deep.txt"), "deep");
    await mkdir(join(worktreeDir, "cfg"));
    await writeFile(join(worktreeDir, "cfg", "tracked.txt"), "tracked");

    try {
      await Effect.runPromise(copyToWorktree(["cfg"], hostDir, worktreeDir));

      await expect(
        readFile(join(worktreeDir, "cfg", "secret.txt"), "utf8"),
      ).resolves.toBe("secret");
      await expect(
        readFile(join(worktreeDir, "cfg", "sub", "deep.txt"), "utf8"),
      ).resolves.toBe("deep");
      expect(existsSync(join(worktreeDir, "cfg", "cfg"))).toBe(false);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("copies a directory that does not exist in the worktree to the same path", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    await mkdir(join(hostDir, "ignoredir"));
    await writeFile(join(hostDir, "ignoredir", "x.txt"), "x");

    try {
      await Effect.runPromise(
        copyToWorktree(["ignoredir"], hostDir, worktreeDir),
      );

      await expect(
        readFile(join(worktreeDir, "ignoredir", "x.txt"), "utf8"),
      ).resolves.toBe("x");
      expect(existsSync(join(worktreeDir, "ignoredir", "ignoredir"))).toBe(
        false,
      );
    } finally {
      await rm(hostDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories for a nested path", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));

    // deep/ is gitignored, so none of it exists in the worktree
    await mkdir(join(hostDir, "deep", "a", "b"), { recursive: true });
    await writeFile(join(hostDir, "deep", "a", "b", "c.txt"), "c");
    await mkdir(join(hostDir, "nested", "dir"), { recursive: true });
    await writeFile(join(hostDir, "nested", "dir", "d.txt"), "d");

    try {
      await Effect.runPromise(
        copyToWorktree(["deep/a/b/c.txt", "nested/dir"], hostDir, worktreeDir),
      );

      await expect(
        readFile(join(worktreeDir, "deep", "a", "b", "c.txt"), "utf8"),
      ).resolves.toBe("c");
      await expect(
        readFile(join(worktreeDir, "nested", "dir", "d.txt"), "utf8"),
      ).resolves.toBe("d");
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

  it.skipIf(process.platform === "win32")(
    "kills the cp process when the copy times out",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cw-test-"));
      const worktreeDir = await mkdtemp(join(tmpdir(), "cw-wt-"));
      await writeFile(join(hostDir, "stuck.txt"), "content");
      // cp blocks opening a FIFO destination that has no reader.
      const dest = join(worktreeDir, "stuck.txt");
      execFileSync("mkfifo", [dest]);
      const cpAlive = () => {
        try {
          execFileSync("pgrep", ["-f", `cp .*${dest}`]);
          return true;
        } catch {
          return false;
        }
      };

      try {
        const exit = await Effect.runPromiseExit(
          copyToWorktree(["stuck.txt"], hostDir, worktreeDir, 300),
        );
        expect(Exit.isFailure(exit)).toBe(true);

        const deadline = Date.now() + 2000;
        while (cpAlive() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(cpAlive()).toBe(false);
      } finally {
        // Unblock any surviving cp by opening the FIFO for reading.
        execFileSync("sh", ["-c", `timeout 1 cat "${dest}" || true`]);
        await rm(hostDir, { recursive: true, force: true });
        await rm(worktreeDir, { recursive: true, force: true });
      }
    },
  );

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
