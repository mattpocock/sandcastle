import { NodeContext } from "@effect/platform-node";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  resolveCwd,
  CwdError,
  resolveStateDir,
  DEFAULT_STATE_DIR,
} from "./resolveCwd.js";

describe("resolveCwd", () => {
  it("returns process.cwd() when input is undefined", async () => {
    const result = await Effect.runPromise(
      resolveCwd(undefined).pipe(Effect.provide(NodeContext.layer)),
    );
    expect(result).toBe(resolve(process.cwd()));
  });

  it("resolves a relative path against process.cwd()", async () => {
    const result = await Effect.runPromise(
      resolveCwd(".").pipe(Effect.provide(NodeContext.layer)),
    );
    expect(result).toBe(resolve(process.cwd()));
  });

  it("passes through an absolute path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwd-abs-"));
    try {
      const result = await Effect.runPromise(
        resolveCwd(dir).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(result).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails with CwdError for a non-existent path", async () => {
    const result = await Effect.runPromise(
      resolveCwd("/tmp/does-not-exist-12345").pipe(
        Effect.flip,
        Effect.provide(NodeContext.layer),
      ),
    );
    expect(result).toBeInstanceOf(CwdError);
    expect(result.cwd).toBe("/tmp/does-not-exist-12345");
    expect(result.message).toMatch(/does not exist/i);
  });

  it("fails with CwdError when path is a file, not a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwd-file-"));
    const filePath = join(dir, "afile.txt");
    await writeFile(filePath, "hello");
    try {
      const result = await Effect.runPromise(
        resolveCwd(filePath).pipe(
          Effect.flip,
          Effect.provide(NodeContext.layer),
        ),
      );
      expect(result).toBeInstanceOf(CwdError);
      expect(result.cwd).toBe(filePath);
      expect(result.message).toMatch(/not a directory/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a symlink to a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwd-sym-"));
    const linkPath = join(dir, "link");
    await symlink(dir, linkPath);
    try {
      const result = await Effect.runPromise(
        resolveCwd(linkPath).pipe(Effect.provide(NodeContext.layer)),
      );
      expect(result).toBe(linkPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveStateDir", () => {
  it("joins DEFAULT_STATE_DIR to the anchor", () => {
    expect(resolveStateDir("/repo", DEFAULT_STATE_DIR)).toBe(
      join("/repo", DEFAULT_STATE_DIR),
    );
    expect(DEFAULT_STATE_DIR).toBe(".sandcastle");
  });

  it("joins a relative stateDir to the anchor", () => {
    expect(resolveStateDir("/repo", ".mytool.local")).toBe(
      "/repo/.mytool.local",
    );
  });

  it("uses an absolute stateDir verbatim, ignoring the anchor", () => {
    expect(resolveStateDir("/repo", "/var/state/mine")).toBe("/var/state/mine");
  });
});
