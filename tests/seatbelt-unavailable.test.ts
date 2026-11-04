import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeSandboxUnavailableError } from "@ai-hero/sandcastle";
import { seatbelt } from "@ai-hero/sandcastle/sandboxes/seatbelt";

// seatbelt() checks at construction that Seatbelt is usable, and throws
// NativeSandboxUnavailableError when it isn't. Off macOS it always fails,
// which is what runs on the Linux and Windows jobs.

/** The error `fn` throws, or a failure if it doesn't throw. */
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

describe.skipIf(process.platform === "darwin")("seatbelt() off macOS", () => {
  let hostTmp = "";
  let originalTmpdir: string | undefined;

  beforeEach(() => {
    hostTmp = mkdtempSync(path.join(tmpdir(), "e2e-seatbelt-host-tmp-"));
    originalTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = hostTmp;
  });

  afterEach(() => {
    process.env["TMPDIR"] = originalTmpdir;
    rmSync(hostTmp, { recursive: true, force: true });
  });

  it("throws NativeSandboxUnavailableError naming bwrap(), with no fix command", () => {
    const error = thrownBy(() => seatbelt());

    expect(error).toBeInstanceOf(NativeSandboxUnavailableError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "seatbelt() needs macOS; on Linux or WSL2 use bwrap()",
    });
    expect(error).not.toHaveProperty("fixCommand");
  });

  it("leaves no temp dir behind", () => {
    thrownBy(() => seatbelt());

    expect(readdirSync(hostTmp)).toStrictEqual([]);
  });
});
