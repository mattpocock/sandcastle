import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BranchStrategy } from "@ai-hero/sandcastle";
import { claudeCode, run } from "@ai-hero/sandcastle";
import { seatbelt } from "@ai-hero/sandcastle/sandboxes/seatbelt";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";

// run() with seatbelt() and the real claudeCode() agent factory, against a
// harmless fake `claude`: a shell script on a read-only mount, found through
// the host PATH. It reads its prompt from stdin, writes a session file into
// its home, commits, and prints the stream-json Claude Code would print.
// Mirrors tests/bwrap-run.test.ts.

// Gated like the containment suite: skipped off macOS, but a broken
// sandbox-exec fails when CI is set. The macOS CI job is the only place this
// runs.
const SEATBELT = NATIVE_PROVIDERS.find((p) => p.name === "seatbelt()");
if (SEATBELT === undefined) {
  throw new Error("NATIVE_PROVIDERS has no seatbelt() entry");
}

const SESSION_ID = "sess-seatbelt-e2e";
const IDENTITY = { name: "Seatbelt E2E", email: "seatbelt-e2e@example.com" };

/**
 * The fake `claude`. The prompt picks its behaviour: `HANG` prints the init
 * line and then goes silent; `SLOW` spaces its lines out; anything else is
 * quick. It commits the prompt and its global git email, then reports done.
 */
const FAKE_CLAUDE = `#!/bin/sh
prompt=$(cat)
line() { printf '%s\\n' "$1"; }
line '{"type":"system","subtype":"init","session_id":"${SESSION_ID}"}'
case "$prompt" in
  *HANG*) sleep 60; exit 0 ;;
esac
pause() { case "$prompt" in *SLOW*) sleep 0.6 ;; esac; }
project="$HOME/.claude/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$project"
line '{"type":"summary","summary":"fake-session-marker"}' > "$project/${SESSION_ID}.jsonl"
printf '%s\\n' "$prompt" > agent.txt
git config --global user.email > identity.txt
git add agent.txt identity.txt
git commit -qm "agent commit"
pause
line '{"type":"assistant","message":{"content":[{"type":"text","text":"Working."}]}}'
pause
line '{"type":"assistant","message":{"content":[{"type":"text","text":"Done. <promise>COMPLETE</promise>"}]}}'
pause
line '{"type":"result","subtype":"success","result":"Done. <promise>COMPLETE</promise>"}'
`;

describe.skipIf(skipsHere(SEATBELT))(
  "run() with seatbelt() and a fake claude",
  () => {
    beforeAll(() => {
      assertUsable(SEATBELT);
    });

    let repo = "";
    let scratch = "";
    let fakeBin = "";
    let originalPath: string | undefined;

    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

    beforeEach(() => {
      // macOS's tmpdir is behind the /var -> /private/var symlink. Claude
      // Code names its project dir from its physical cwd, so the repo is
      // given by its real path, as a repo under the home dir already is.
      repo = realpathSync(
        mkdtempSync(path.join(tmpdir(), "e2e-seatbelt-run-")),
      );
      scratch = realpathSync(
        mkdtempSync(path.join(tmpdir(), "e2e-seatbelt-run-scratch-")),
      );
      fakeBin = path.join(scratch, "bin");
      mkdirSync(fakeBin);
      writeFileSync(path.join(fakeBin, "claude"), FAKE_CLAUDE);
      chmodSync(path.join(fakeBin, "claude"), 0o755);
      originalPath = process.env["PATH"];
      process.env["PATH"] = `${fakeBin}:${originalPath ?? ""}`;

      git("init", "-b", "main");
      git("config", "user.name", IDENTITY.name);
      git("config", "user.email", IDENTITY.email);
      writeFileSync(path.join(repo, "README.md"), "# repo\n");
      git("add", ".");
      git("commit", "-m", "init");
    });

    afterEach(() => {
      process.env["PATH"] = originalPath;
      rmSync(repo, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    });

    const runFake = async (
      prompt: string,
      options: {
        branchStrategy?: BranchStrategy;
        idleTimeoutSeconds?: number;
        hooks?: Parameters<typeof run>[0]["hooks"];
      } = {},
    ) =>
      run({
        agent: claudeCode("claude-opus-4-8", {
          sessionStorage: { hostProjectsDir: path.join(scratch, "projects") },
        }),
        sandbox: seatbelt({
          mounts: [{ hostPath: fakeBin, sandboxPath: fakeBin, readonly: true }],
        }),
        cwd: repo,
        prompt,
        branchStrategy: options.branchStrategy ?? { type: "head" },
        idleTimeoutSeconds: options.idleTimeoutSeconds,
        hooks: options.hooks,
        logging: { type: "file", path: path.join(scratch, "run.log") },
      });

    it("runs the agent CLI from the host PATH and lands its commit on head", async () => {
      const result = await runFake("Write the file.");

      expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
      expect(result.commits).toHaveLength(1);
      expect(git("show", "main:agent.txt")).toContain("Write the file.");
    }, 30_000);

    it("lands one commit on head after merge-to-head", async () => {
      const result = await runFake("Merge me.", {
        branchStrategy: { type: "merge-to-head" },
      });

      expect(result.commits).toHaveLength(1);
      expect(git("rev-list", "--count", "main")).toBe("2");
      expect(git("show", "main:agent.txt")).toContain("Merge me.");
    }, 30_000);

    it("lands one commit on the named branch", async () => {
      const result = await runFake("Branch me.", {
        branchStrategy: { type: "branch", branch: "work" },
      });

      expect(result.commits).toHaveLength(1);
      expect(git("rev-list", "--count", "main..work")).toBe("1");
      expect(git("show", "work:agent.txt")).toContain("Branch me.");
    }, 30_000);

    it("writes the host git identity into the private home, so commits carry it", async () => {
      await runFake("Commit as me.");

      expect(git("log", "-1", "--format=%an <%ae>", "main")).toBe(
        `${IDENTITY.name} <${IDENTITY.email}>`,
      );
      expect(git("show", "main:identity.txt")).toBe(IDENTITY.email);
    }, 30_000);

    it("copies the agent's session file out of the private home", async () => {
      const result = await runFake("Keep my session.");

      const sessionFile = result.iterations[0]?.sessionFilePath;
      expect(sessionFile).toBeTypeOf("string");
      expect(readFileSync(String(sessionFile), "utf8")).toContain(
        "fake-session-marker",
      );
    }, 30_000);

    it("copies the session out of a host-path worktree under .sandcastle/worktrees", async () => {
      const result = await runFake("Keep my worktree session.", {
        branchStrategy: { type: "merge-to-head" },
      });

      const sessionFile = result.iterations[0]?.sessionFilePath;
      expect(readFileSync(String(sessionFile), "utf8")).toContain(
        "fake-session-marker",
      );
      expect(git("branch", "--list", "sandcastle/*")).toBe("");
    }, 30_000);

    it("keeps a slow but streaming agent alive past the idle timeout", async () => {
      const result = await runFake("SLOW work.", { idleTimeoutSeconds: 1 });

      expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
    }, 30_000);

    it("fails an agent that goes silent past the idle timeout", async () => {
      await expect(
        runFake("HANG forever.", { idleTimeoutSeconds: 1 }),
      ).rejects.toThrow(/idle/iu);
    }, 30_000);

    it("runs onSandboxReady hooks inside the sandbox, with the private home", async () => {
      await runFake("After the hook.", {
        hooks: {
          sandbox: {
            onSandboxReady: [{ command: 'echo "$HOME" > hook-home.txt' }],
          },
        },
      });

      // Seatbelt can't remap paths: HOME is the private dir's real path,
      // never the host home, and it's gone once the run closes the sandbox.
      const hookHome = readFileSync(
        path.join(repo, "hook-home.txt"),
        "utf8",
      ).trim();
      expect(path.isAbsolute(hookHome)).toBe(true);
      expect(hookHome).not.toBe(homedir());
      expect(existsSync(hookHome)).toBe(false);
    }, 30_000);

    it("fails a sudo onSandboxReady hook, naming seatbelt() and pointing to docker()", async () => {
      await expect(
        runFake("Never reached.", {
          hooks: {
            sandbox: { onSandboxReady: [{ command: "true", sudo: true }] },
          },
        }),
      ).rejects.toThrow(/seatbelt\(\).*docker\(\)/su);
    }, 30_000);
  },
);
