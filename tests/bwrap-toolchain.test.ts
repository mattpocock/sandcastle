import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";

// bwrap()'s toolchain and mounts: what the host PATH and the `mounts` option
// make visible inside the sandbox, probed through createSandbox() and exec.

// Gated like the containment suite: skipped off Linux and where bwrap is
// missing, but a missing bwrap fails when CI is set.
const BWRAP = NATIVE_PROVIDERS.find((p) => p.name === "bwrap()");
if (BWRAP === undefined) {
  throw new Error("NATIVE_PROVIDERS has no bwrap() entry");
}

const HOST_PATH = process.env["PATH"] ?? "";

const writeScript = (file: string, body: string): void => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

describe("bwrap() mounts", () => {
  it("throws at construction when a mount's sandboxPath differs from its hostPath", () => {
    const hostPath = mkdtempSync(path.join(tmpdir(), "e2e-bwrap-mount-"));
    try {
      expect(() =>
        bwrap({ mounts: [{ hostPath, sandboxPath: "/data" }] }),
      ).toThrow(/sandboxPath must equal hostPath/u);
    } finally {
      rmSync(hostPath, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skipsHere(BWRAP))(
  "bwrap() toolchain from the host PATH",
  () => {
    beforeAll(() => {
      assertUsable(BWRAP);
    });

    let repo = "";
    let scratch = "";
    let originalPath: string | undefined;
    let originalHome: string | undefined;

    beforeEach(() => {
      repo = mkdtempSync(path.join(tmpdir(), "e2e-bwrap-toolchain-"));
      scratch = mkdtempSync(
        path.join(tmpdir(), "e2e-bwrap-toolchain-scratch-"),
      );
      originalPath = process.env["PATH"];
      originalHome = process.env["HOME"];
      const git = (...args: string[]): void => {
        execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      };
      git("init", "-b", "main");
      writeFileSync(path.join(repo, "README.md"), "# repo\n");
      git("add", ".");
      git("commit", "-m", "init");
    });

    afterEach(() => {
      process.env["PATH"] = originalPath;
      process.env["HOME"] = originalHome;
      rmSync(repo, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    });

    it("never mounts a PATH entry that is the home dir or an ancestor of it", async () => {
      const home = path.join(scratch, "home", "dev");
      const homeBin = path.join(home, "bin");
      mkdirSync(homeBin, { recursive: true });
      writeFileSync(path.join(home, "secret"), "planted\n");
      writeScript(path.join(homeBin, "home-tool"), "echo home-tool ran");
      process.env["HOME"] = home;
      process.env["PATH"] = [home, path.dirname(home), homeBin, HOST_PATH].join(
        ":",
      );

      await using sandbox = await createSandbox({
        branch: "work",
        sandbox: bwrap(),
        cwd: repo,
      });
      const secret = await sandbox.exec(`cat ${path.join(home, "secret")}`);
      const tool = await sandbox.exec("home-tool");

      expect(secret.exitCode).not.toBe(0);
      expect(secret.stdout).not.toContain("planted");
      expect(tool).toMatchObject({ exitCode: 0, stdout: "home-tool ran\n" });
    });

    it("makes readable the install root of an executable symlinked from a PATH dir", async () => {
      // An npm-style global install: the bin is a symlink into its package,
      // and the script reads a file elsewhere in that package.
      const pkg = path.join(scratch, "lib", "node_modules", "fake-agent");
      mkdirSync(path.join(pkg, "bin"), { recursive: true });
      mkdirSync(path.join(pkg, "data"));
      writeFileSync(path.join(pkg, "package.json"), "{}\n");
      writeFileSync(path.join(pkg, "data", "greeting.txt"), "hello from pkg\n");
      writeScript(
        path.join(pkg, "bin", "fake-agent"),
        'cat "$(dirname "$(readlink -f "$0")")/../data/greeting.txt"',
      );
      const pathBin = path.join(scratch, "bin");
      mkdirSync(pathBin);
      symlinkSync(
        path.join(pkg, "bin", "fake-agent"),
        path.join(pathBin, "fake-agent"),
      );
      process.env["PATH"] = `${pathBin}:${HOST_PATH}`;

      await using sandbox = await createSandbox({
        branch: "work",
        sandbox: bwrap(),
        cwd: repo,
      });
      const result = await sandbox.exec("fake-agent");

      expect(result).toMatchObject({ exitCode: 0, stdout: "hello from pkg\n" });
    });

    it("makes a read-write mount writable and a read-only mount read-only", async () => {
      const cache = path.join(scratch, "cache");
      const shared = path.join(scratch, "shared");
      mkdirSync(cache);
      mkdirSync(shared);
      writeFileSync(path.join(shared, "notes.txt"), "shared notes\n");

      await using sandbox = await createSandbox({
        branch: "work",
        sandbox: bwrap({
          mounts: [
            { hostPath: cache, sandboxPath: cache },
            { hostPath: shared, sandboxPath: shared, readonly: true },
          ],
        }),
        cwd: repo,
      });
      const write = await sandbox.exec(`echo cached > ${cache}/entry`);
      const read = await sandbox.exec(`cat ${shared}/notes.txt`);
      const writeReadonly = await sandbox.exec(`echo no > ${shared}/notes.txt`);

      expect(write.exitCode).toBe(0);
      expect(read).toMatchObject({ exitCode: 0, stdout: "shared notes\n" });
      expect(writeReadonly.exitCode).not.toBe(0);
    });
  },
);
