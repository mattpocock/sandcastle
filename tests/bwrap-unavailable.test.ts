import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeSandboxUnavailableError } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";

// bwrap() checks at construction that Bubblewrap is usable, and throws
// NativeSandboxUnavailableError when it isn't. The check runs once per
// process, so each case that must see it fail lives in this file, which
// never constructs a working bwrap().

/** The error `fn` throws, or a failure if it doesn't throw. */
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

describe.skipIf(process.platform !== "linux")(
  "bwrap() on Linux without Bubblewrap on PATH",
  () => {
    let emptyDir = "";
    let hostTmp = "";
    const original = {
      PATH: process.env["PATH"],
      TMPDIR: process.env["TMPDIR"],
    };

    beforeEach(() => {
      emptyDir = mkdtempSync(path.join(tmpdir(), "e2e-bwrap-empty-path-"));
      hostTmp = mkdtempSync(path.join(tmpdir(), "e2e-bwrap-host-tmp-"));
      process.env["PATH"] = emptyDir;
      process.env["TMPDIR"] = hostTmp;
    });

    afterEach(() => {
      process.env["PATH"] = original.PATH;
      process.env["TMPDIR"] = original.TMPDIR;
      rmSync(emptyDir, { recursive: true, force: true });
      rmSync(hostTmp, { recursive: true, force: true });
    });

    it("throws NativeSandboxUnavailableError whose fixCommand installs bubblewrap", () => {
      const error = thrownBy(() => bwrap());

      expect(error).toBeInstanceOf(NativeSandboxUnavailableError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        fixCommand: expect.stringMatching(
          /^sudo (?:apt|dnf|pacman|apk|zypper) .*bubblewrap$/u,
        ) as unknown,
      });
    });

    it("leaves no temp dir behind", () => {
      thrownBy(() => bwrap());

      expect(readdirSync(hostTmp)).toStrictEqual([]);
    });
  },
);

describe.skipIf(process.platform === "linux")("bwrap() off Linux", () => {
  it("throws NativeSandboxUnavailableError naming WSL2 and seatbelt(), with no fix command", () => {
    const error = thrownBy(() => bwrap());

    expect(error).toBeInstanceOf(NativeSandboxUnavailableError);
    expect(error).toMatchObject({
      message: "bwrap() needs Linux or WSL2; on macOS use seatbelt()",
      fixCommand: undefined,
    });
  });
});
