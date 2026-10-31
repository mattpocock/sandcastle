import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createSandbox } from "@ai-hero/sandcastle";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";

// The containment suite: what a native sandbox lets the agent do, and what it
// stops, proven on the real OS mechanism through the public API. Every
// provider in NATIVE_PROVIDERS runs the same probes. A provider is skipped on
// other OSes and where its tool is missing, but fails when `CI` is set.

const CANARY = "SANDCASTLE_CONTAINMENT_CANARY";
const DECLARED = "SANDCASTLE_CONTAINMENT_DECLARED";

describe.each(NATIVE_PROVIDERS)("containment: $name", (provider) => {
  describe.skipIf(skipsHere(provider))("on this host", () => {
    let repo = "";
    let outside = "";

    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" });

    const open = async (): Promise<Awaited<ReturnType<typeof createSandbox>>> =>
      createSandbox({
        branch: "work",
        sandbox: provider.make(),
        cwd: repo,
      });

    beforeAll(() => {
      assertUsable(provider);
    });

    beforeEach(() => {
      repo = mkdtempSync(path.join(tmpdir(), "e2e-containment-"));
      outside = mkdtempSync(path.join(tmpdir(), "e2e-containment-outside-"));
      git(repo, "init", "-b", "main");
      writeFileSync(path.join(repo, "README.md"), "# repo\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "init");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it("lets a write inside the worktree through to the host", async () => {
      await using sandbox = await open();

      const result = await sandbox.exec("echo inside > written.txt");

      expect(result.exitCode).toBe(0);
      expect(
        readFileSync(path.join(sandbox.worktreePath, "written.txt"), "utf8"),
      ).toBe("inside\n");
    });

    it("stops a write to a host dir outside the worktree", async () => {
      await using sandbox = await open();
      const target = path.join(outside, "escaped.txt");

      const result = await sandbox.exec(`echo escaped > '${target}'`);

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    });

    it("keeps a write to the host repo, outside the worktree, off the host", async () => {
      await using sandbox = await open();
      const target = path.join(repo, "escaped.txt");

      await sandbox.exec(`echo escaped > '${target}'`);

      expect(existsSync(target)).toBe(false);
    });

    it("lets the agent commit to its branch", async () => {
      await using sandbox = await open();

      // The identity is passed inline: this probes that the git dirs are
      // writable, not how the identity reaches the sandbox.
      const result = await sandbox.exec(
        "echo change > change.txt && git add change.txt && " +
          "git -c user.name=Agent -c user.email=agent@example.com commit -m 'from the sandbox'",
      );

      expect(result.exitCode).toBe(0);
      expect(git(repo, "log", "-1", "--format=%s", "work").trim()).toBe(
        "from the sandbox",
      );
    });

    it("hides an undeclared host env var and passes a declared one", async () => {
      vi.stubEnv(CANARY, "host-secret");
      vi.stubEnv(DECLARED, "declared-value");
      mkdirSync(path.join(repo, ".sandcastle"));
      writeFileSync(path.join(repo, ".sandcastle", ".env"), `${DECLARED}=\n`);
      await using sandbox = await open();

      const result = await sandbox.exec(
        `echo "canary=\${${CANARY}:-unset}"; echo "declared=\${${DECLARED}:-unset}"`,
      );

      expect(result.stdout).toBe("canary=unset\ndeclared=declared-value\n");
    });
  });
});
