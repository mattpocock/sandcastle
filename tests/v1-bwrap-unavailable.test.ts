import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateSandboxError, createSandbox } from "@ai-hero/sandcastle/v1";
import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";

// v1's bwrap() checks at create that Bubblewrap is usable, with 0.x's
// preflight and its messages. The check runs once per process, so each case
// that must see it fail lives in this file, which never makes a working
// bwrap() sandbox.

describe("bwrap() (v1) where Bubblewrap can't run", () => {
  let emptyDir = "";
  let state = "";
  const original = {
    PATH: process.env["PATH"],
    XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
  };

  beforeEach(async () => {
    emptyDir = await mkdtemp(path.join(tmpdir(), "v1-bwrap-empty-path-"));
    state = await mkdtemp(path.join(tmpdir(), "v1-bwrap-state-"));
    process.env["PATH"] = emptyDir;
    process.env["XDG_STATE_HOME"] = state;
  });

  afterEach(async () => {
    process.env["PATH"] = original.PATH;
    process.env["XDG_STATE_HOME"] = original.XDG_STATE_HOME;
    await rm(emptyDir, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });

  it.runIf(process.platform === "linux")(
    "fails at create, saying how to install Bubblewrap, and leaves nothing behind",
    async () => {
      const created = createSandbox({ provider: bwrap() });

      await expect(created).rejects.toBeInstanceOf(CreateSandboxError);
      await expect(created).rejects.toThrow(
        /bwrap\(\) needs Bubblewrap, and `bwrap` isn't on PATH/u,
      );
      await expect(readdir(state)).resolves.toStrictEqual([]);
    },
  );

  it.runIf(process.platform !== "linux")(
    "fails at create off Linux, naming WSL2 and seatbelt(), and leaves nothing behind",
    async () => {
      const created = createSandbox({ provider: bwrap() });

      await expect(created).rejects.toBeInstanceOf(CreateSandboxError);
      await expect(created).rejects.toThrow(
        "bwrap() needs Linux or WSL2; on macOS use seatbelt()",
      );
      await expect(readdir(state)).resolves.toStrictEqual([]);
    },
  );
});
