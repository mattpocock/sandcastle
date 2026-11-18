import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateSandboxError, createSandbox } from "@ai-hero/sandcastle/v1";
import { seatbelt } from "@ai-hero/sandcastle/v1/sandboxes/seatbelt";

// v1's seatbelt() off macOS, and its option checks, which hold on every OS.
// The macOS-only suite is tests/v1-seatbelt.test.ts.

describe("seatbelt() (v1) off macOS, and its options", () => {
  let state = "";
  const originalState = process.env["XDG_STATE_HOME"];

  beforeEach(async () => {
    state = await mkdtemp(path.join(tmpdir(), "v1-seatbelt-state-"));
    process.env["XDG_STATE_HOME"] = state;
  });

  afterEach(async () => {
    process.env["XDG_STATE_HOME"] = originalState;
    await rm(state, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "darwin")(
    "fails at create, saying it needs macOS, and leaves nothing behind",
    async () => {
      const created = createSandbox({ provider: seatbelt() });

      await expect(created).rejects.toBeInstanceOf(CreateSandboxError);
      await expect(created).rejects.toThrow(
        "seatbelt() needs macOS; on Linux or WSL2 use bwrap()",
      );
      await expect(readdir(state)).resolves.toStrictEqual([]);
    },
  );

  it("refuses a toolchain path that would show the home folder, or isn't absolute", () => {
    expect(() => seatbelt({ create: { toolchainPaths: [homedir()] } })).toThrow(
      /home folder/u,
    );
    expect(() => seatbelt({ create: { toolchainPaths: ["/"] } })).toThrow(
      /home folder/u,
    );
    expect(() =>
      seatbelt({ create: { toolchainPaths: ["opt/tool"] } }),
    ).toThrow(/absolute/u);
  });
});
