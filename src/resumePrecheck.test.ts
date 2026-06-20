import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCode, codex, copilot, pi } from "./AgentProvider.js";
import { assertResumeSessionExists } from "./resumePrecheck.js";

const SESSION_ID = "9ba1c695-2222-4444-8888-e7e847bf34dd";

describe("assertResumeSessionExists", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "resume-precheck-"));
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
  });

  describe("no-sandbox (Claude Code)", () => {
    it("passes when the session lives under a cwd-encoded dir that does not match the host repo dir", async () => {
      // Simulate the agent having written the session in place from a worktree:
      // the encoded directory reflects a realpath'd `.sandcastle/worktrees/...`
      // path, which the host-repo-dir encoding would never reconstruct.
      const misEncodedDir = join(
        projectsDir,
        "-private-tmp-myrepo--sandcastle-worktrees-feature",
      );
      await mkdir(misEncodedDir, { recursive: true });
      await writeFile(join(misEncodedDir, `${SESSION_ID}.jsonl`), "{}");

      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "none",
          hostRepoDir: "/some/unrelated/host/repo",
          resumeSession: SESSION_ID,
        }),
      ).resolves.toBeUndefined();
    });

    it("throws an error naming the searched root when the session is absent", async () => {
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "none",
          hostRepoDir: "/some/host/repo",
          resumeSession: "missing-id",
        }),
      ).rejects.toThrow(
        `resumeSession "missing-id" not found under ${projectsDir}`,
      );
    });
  });

  describe("no-sandbox (Pi)", () => {
    it("resolves when the session file exists under a --enc-cwd-- directory", async () => {
      const filename = `2026-05-29T08-00-00_${SESSION_ID}.jsonl`;
      const sessionPath = join(projectsDir, "--some-encoded-cwd--", filename);
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, JSON.stringify({ type: "session" }));

      const provider = pi("claude-sonnet-4-6", {
        sessionStorage: { hostSessionsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "none",
          hostRepoDir: "/some/unrelated/host/repo",
          resumeSession: SESSION_ID,
        }),
      ).resolves.toBeUndefined();
    });

    it("throws naming the searched root when no matching session exists", async () => {
      const provider = pi("claude-sonnet-4-6", {
        sessionStorage: { hostSessionsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "none",
          hostRepoDir: "/some/host/repo",
          resumeSession: "missing-id",
        }),
      ).rejects.toThrow(
        `resumeSession "missing-id" not found under ${projectsDir}`,
      );
    });
  });

  describe("sandboxed (Pi, bind-mount)", () => {
    it("passes when a session file exists at the host-repo-dir encoded location", async () => {
      const provider = pi("claude-sonnet-4-6", {
        sessionStorage: { hostSessionsDir: projectsDir },
      });
      const hostRepoDir = "/some/host/repo";
      const sessionDir = provider.sessionStorage.hostSessionFilePath(
        hostRepoDir,
        SESSION_ID,
      )!;
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, `2026-05-29T08-00-00_${SESSION_ID}.jsonl`),
        "{}",
      );

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "bind-mount",
          hostRepoDir,
          resumeSession: SESSION_ID,
        }),
      ).resolves.toBeUndefined();
    });

    it("throws naming the expected session directory when no file is present", async () => {
      const provider = pi("claude-sonnet-4-6", {
        sessionStorage: { hostSessionsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "bind-mount",
          hostRepoDir: "/some/host/repo",
          resumeSession: "abc-123",
        }),
      ).rejects.toThrow(
        'resumeSession "abc-123" not found: expected session file at',
      );
    });
  });

  describe("no-sandbox (Codex)", () => {
    it("resolves when the rollout file exists under the date-nested sessions dir", async () => {
      const sessionPath = join(
        projectsDir,
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${SESSION_ID}.jsonl`,
      );
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, JSON.stringify({ type: "session_meta" }));

      const provider = codex("gpt-5.4-mini", {
        sessionStorage: { hostSessionsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "none",
          hostRepoDir: "/some/unrelated/host/repo",
          resumeSession: SESSION_ID,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("sandboxed (bind-mount / isolated)", () => {
    it("checks the exact host-repo-dir encoded location and names the expected file path on a miss", async () => {
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: projectsDir },
      });

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "bind-mount",
          hostRepoDir: "/some/host/repo",
          resumeSession: "abc-123",
        }),
      ).rejects.toThrow(
        'resumeSession "abc-123" not found: expected session file at',
      );
    });

    it("passes when the session exists at the host-repo-dir encoded location", async () => {
      const provider = claudeCode("claude-opus-4-8", {
        sessionStorage: { hostProjectsDir: projectsDir },
      });
      const hostRepoDir = "/some/host/repo";
      const sessionPath = provider.sessionStorage.hostSessionFilePath(
        hostRepoDir,
        SESSION_ID,
      )!;
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      await expect(
        assertResumeSessionExists({
          provider,
          sandboxTag: "bind-mount",
          hostRepoDir,
          resumeSession: SESSION_ID,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("throws when the provider does not support resume (no sessionStorage)", async () => {
    await expect(
      assertResumeSessionExists({
        provider: copilot("claude-sonnet-4.5"),
        sandboxTag: "none",
        hostRepoDir: "/some/host/repo",
        resumeSession: SESSION_ID,
      }),
    ).rejects.toThrow("copilot does not support resumeSession");
  });
});
