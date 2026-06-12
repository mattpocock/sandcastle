import { describe, expect, it } from "vitest";
import {
  claudeSubagentsDirInSandbox,
  claudeSubagentsDirOnHost,
  encodePiSessionDir,
  encodeProjectPath,
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
  findPiSessionOnHost,
  listClaudeSubagentSessionsInSandbox,
  locateCodexHostSession,
  locatePiHostSession,
  piSessionDirPath,
  transferClaudeSession,
  transferCodexSession,
  transferPiSession,
} from "./SessionStore.js";
import { exec as cpExec } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(cpExec);

// ---------------------------------------------------------------------------
// encodeProjectPath
// ---------------------------------------------------------------------------

describe("encodeProjectPath", () => {
  it("encodes absolute path by replacing path separators with hyphens", () => {
    expect(encodeProjectPath("/home/user/repos/my-project")).toBe(
      "-home-user-repos-my-project",
    );
  });

  it("encodes root path", () => {
    expect(encodeProjectPath("/")).toBe("-");
  });

  it("encodes path without leading slash", () => {
    expect(encodeProjectPath("home/user")).toBe("home-user");
  });

  it("strips trailing slash before encoding", () => {
    expect(encodeProjectPath("/home/user/")).toBe("-home-user");
  });

  it("encodes Windows path with backslashes and drive letter", () => {
    expect(encodeProjectPath("D:\\projektit\\super-app")).toBe(
      "D-projektit-super-app",
    );
  });

  it("strips trailing backslash before encoding", () => {
    expect(encodeProjectPath("C:\\Users\\rootti\\repos\\foo\\")).toBe(
      "C-Users-rootti-repos-foo",
    );
  });

  it("encodes Windows drive root", () => {
    expect(encodeProjectPath("C:\\")).toBe("C-");
  });

  it("encodes drive letter without trailing separator", () => {
    expect(encodeProjectPath("C:")).toBe("C");
  });

  it("strips multiple trailing backslashes", () => {
    expect(encodeProjectPath("D:\\projekts\\app\\\\")).toBe("D-projekts-app");
  });
});

// ---------------------------------------------------------------------------
// transferClaudeSession — pure cwd rewriting
// ---------------------------------------------------------------------------

describe("transferClaudeSession", () => {
  it("rewrites cwd fields in JSONL entries from source cwd to target cwd", () => {
    const jsonl = [
      JSON.stringify({ type: "system", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "message", content: "hello" }),
      JSON.stringify({
        type: "tool_call",
        cwd: "/sandbox/worktree",
        name: "Read",
      }),
    ].join("\n");

    const written = transferClaudeSession(
      jsonl,
      "/sandbox/worktree",
      "/home/user/repos/project",
    );
    const lines = written.split("\n");

    expect(JSON.parse(lines[0]!)).toEqual({
      type: "system",
      cwd: "/home/user/repos/project",
    });
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "message",
      content: "hello",
    });
    expect(JSON.parse(lines[2]!)).toEqual({
      type: "tool_call",
      cwd: "/home/user/repos/project",
      name: "Read",
    });
  });

  it("round-trips bytes for entries without cwd", () => {
    const jsonl = [
      JSON.stringify({ type: "message", content: "hello world" }),
      JSON.stringify({
        type: "tool_result",
        output: "result with special chars: \t\n",
      }),
    ].join("\n");

    expect(transferClaudeSession(jsonl, "/src", "/dst")).toBe(jsonl);
  });

  it("handles empty JSONL", () => {
    expect(transferClaudeSession("", "/a", "/b")).toBe("");
  });

  it("only rewrites cwd fields that match source cwd exactly", () => {
    const jsonl = [
      JSON.stringify({ type: "a", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "b", cwd: "/other/path" }),
    ].join("\n");

    const out = transferClaudeSession(jsonl, "/sandbox/worktree", "/host/repo");
    const lines = out.split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    expect(JSON.parse(lines[1]!).cwd).toBe("/other/path");
  });

  it("tolerates malformed lines by preserving them verbatim", () => {
    const badLine = '{"type":"broken"';
    const jsonl = [
      JSON.stringify({ type: "system", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "message", content: "hello" }),
      badLine,
    ].join("\n");

    const out = transferClaudeSession(jsonl, "/sandbox/worktree", "/host/repo");
    const lines = out.split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "message",
      content: "hello",
    });
    expect(lines[2]).toBe(badLine);
  });
});

// ---------------------------------------------------------------------------
// transferCodexSession — pure cwd rewriting on session_meta payload
// ---------------------------------------------------------------------------

describe("transferCodexSession", () => {
  it("rewrites cwd in session_meta payload and top-level cwd fields", () => {
    const jsonl = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "abc", cwd: "/sandbox/repo" },
      }),
      JSON.stringify({ type: "turn_context", cwd: "/sandbox/repo" }),
    ].join("\n");

    const out = transferCodexSession(jsonl, "/sandbox/repo", "/host/repo");
    const lines = out.split("\n");
    expect(JSON.parse(lines[0]!).payload.cwd).toBe("/host/repo");
    expect(JSON.parse(lines[1]!).cwd).toBe("/host/repo");
  });

  it("handles empty JSONL", () => {
    expect(transferCodexSession("", "/a", "/b")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findClaudeSessionOnHost
// ---------------------------------------------------------------------------

describe("findClaudeSessionOnHost", () => {
  it("finds a session by id regardless of which encoded project dir holds it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-claude-"));
    try {
      const id = "session-xyz";
      const projectDir = join(
        dir,
        "-private-tmp-myrepo--sandcastle-worktrees-feature",
      );
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${id}.jsonl`), "{}");

      const result = await findClaudeSessionOnHost(id, dir);

      expect(result.path).toBe(join(projectDir, `${id}.jsonl`));
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path and names the searched root when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-claude-"));
    try {
      const result = await findClaudeSessionOnHost("nope", dir);
      expect(result.path).toBeUndefined();
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path when the projects dir does not exist", async () => {
    const result = await findClaudeSessionOnHost(
      "nope",
      join(tmpdir(), "sandcastle-does-not-exist-xyz"),
    );
    expect(result.path).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCodexSessionOnHost & locateCodexHostSession
// ---------------------------------------------------------------------------

describe("findCodexSessionOnHost", () => {
  it("finds a date-nested rollout file by id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-codex-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const sessionPath = join(
        dir,
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      const result = await findCodexSessionOnHost(id, dir);

      expect(result.path).toBe(sessionPath);
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path and names the searched root when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-codex-"));
    try {
      const result = await findCodexSessionOnHost("missing", dir);
      expect(result.path).toBeUndefined();
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("locateCodexHostSession", () => {
  it("returns absolute path and relative date-nested path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-locate-codex-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const relativePath = join(
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      const sessionPath = join(dir, relativePath);
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      const result = await locateCodexHostSession(id, dir);

      expect(result.path).toBe(sessionPath);
      expect(result.relativePath).toBe(relativePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// encodePiSessionDir
// ---------------------------------------------------------------------------

describe("encodePiSessionDir", () => {
  it("encodes an absolute POSIX path by stripping the leading slash and wrapping in --", () => {
    expect(encodePiSessionDir("/home/user/repos/my-project")).toBe(
      "--home-user-repos-my-project--",
    );
  });

  it("encodes a relative path without a leading separator", () => {
    expect(encodePiSessionDir("home/user")).toBe("--home-user--");
  });

  it("encodes a Windows path with backslashes and drive colon", () => {
    // Pi maps each separator/colon to a single hyphen — so `:\\` becomes `--`,
    // not a normalised single `-`. Matches pi 0.73.1's SessionManager exactly.
    expect(encodePiSessionDir("C:\\repos\\my-app")).toBe("--C--repos-my-app--");
  });
});

// ---------------------------------------------------------------------------
// piSessionDirPath
// ---------------------------------------------------------------------------

describe("piSessionDirPath", () => {
  it("joins the sessions root with the encoded cwd directory", () => {
    expect(piSessionDirPath("/host/repo", "/tmp/pi-sessions")).toBe(
      join("/tmp/pi-sessions", "--host-repo--"),
    );
  });
});

// ---------------------------------------------------------------------------
// transferPiSession — header-only cwd rewrite
// ---------------------------------------------------------------------------

describe("transferPiSession", () => {
  it("rewrites the cwd field on the session header line only", () => {
    const jsonl = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "2026-05-29T08:00:00Z",
        cwd: "/sandbox/repo",
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ].join("\n");

    const out = transferPiSession(jsonl, "/sandbox/repo", "/host/repo");
    const lines = out.split("\n");

    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    // Non-header lines round-trip verbatim — no field renaming, no
    // whitespace shuffling.
    expect(lines[1]).toBe(
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    );
  });

  it("leaves non-header `cwd` fields untouched", () => {
    // Defensive: if a future pi schema starts embedding cwd on other entry
    // types, this test catches the silent drift — transferPiSession is
    // header-only by design (the JSONL shape verified on pi 0.73.1).
    const jsonl = [
      JSON.stringify({ type: "session", id: "abc", cwd: "/sandbox/repo" }),
      JSON.stringify({ type: "message", cwd: "/sandbox/repo" }),
    ].join("\n");

    const out = transferPiSession(jsonl, "/sandbox/repo", "/host/repo");
    const lines = out.split("\n");

    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    expect(JSON.parse(lines[1]!).cwd).toBe("/sandbox/repo");
  });

  it("leaves the header untouched when its cwd does not match fromCwd", () => {
    const jsonl = JSON.stringify({
      type: "session",
      id: "abc",
      cwd: "/other/path",
    });

    expect(transferPiSession(jsonl, "/sandbox/repo", "/host/repo")).toBe(jsonl);
  });

  it("tolerates non-JSON lines by passing them through verbatim", () => {
    const jsonl = [
      "not json",
      JSON.stringify({ type: "session", id: "abc" }),
    ].join("\n");

    expect(transferPiSession(jsonl, "/a", "/b")).toBe(jsonl);
  });

  it("handles empty JSONL", () => {
    expect(transferPiSession("", "/a", "/b")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findPiSessionOnHost & locatePiHostSession
// ---------------------------------------------------------------------------

describe("findPiSessionOnHost", () => {
  it("finds a session by id under its --<enc-cwd>-- directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-pi-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const filename = `2026-05-29T08-00-00_${id}.jsonl`;
      const sessionDir = join(dir, "--home-user-repos-foo--");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, filename), "{}");

      const result = await findPiSessionOnHost(id, dir);

      expect(result.path).toBe(join(sessionDir, filename));
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path and names the searched root when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-pi-"));
    try {
      const result = await findPiSessionOnHost("missing", dir);
      expect(result.path).toBeUndefined();
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path when the sessions dir does not exist", async () => {
    const result = await findPiSessionOnHost(
      "nope",
      join(tmpdir(), "sandcastle-pi-does-not-exist-xyz"),
    );
    expect(result.path).toBeUndefined();
  });
});

describe("locatePiHostSession", () => {
  it("returns absolute path and the --<enc-cwd>--/<filename> relative path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-locate-pi-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const filename = `2026-05-29T08-00-00_${id}.jsonl`;
      const encodedDir = "--home-user-repos-foo--";
      const sessionPath = join(dir, encodedDir, filename);
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      const result = await locatePiHostSession(id, dir);

      expect(result.path).toBe(sessionPath);
      expect(result.relativePath).toBe(join(encodedDir, filename));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws naming the searched root when the session is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-locate-pi-"));
    try {
      await expect(locatePiHostSession("missing", dir)).rejects.toThrow(
        `session missing not found in ${dir}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// claudeSubagentsDirInSandbox
// ---------------------------------------------------------------------------

describe("claudeSubagentsDirInSandbox", () => {
  it("builds <projectsDir>/<encoded-cwd>/<sessionId>/subagents with POSIX separators", () => {
    expect(
      claudeSubagentsDirInSandbox(
        "/sandbox/repo",
        "sess-1",
        "/home/agent/.claude/projects",
      ),
    ).toBe("/home/agent/.claude/projects/-sandbox-repo/sess-1/subagents");
  });
});

// ---------------------------------------------------------------------------
// claudeSubagentsDirOnHost
// ---------------------------------------------------------------------------

describe("claudeSubagentsDirOnHost", () => {
  it("builds the host equivalent using node:path join", () => {
    const projectsDir = "/tmp/claude-projects";
    expect(claudeSubagentsDirOnHost("/host/repo", "sess-1", projectsDir)).toBe(
      join(projectsDir, "-host-repo", "sess-1", "subagents"),
    );
  });
});

// ---------------------------------------------------------------------------
// listClaudeSubagentSessionsInSandbox
// ---------------------------------------------------------------------------

/** Minimal real-fs exec handle for sandbox find tests. */
const makeFsHandle = () => ({
  exec: async (
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    try {
      const { stdout, stderr } = await execAsync(command);
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: e.code ?? 1,
      };
    }
  },
});

describe("listClaudeSubagentSessionsInSandbox", () => {
  it("returns [] when the subagents dir does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-subagents-"));
    try {
      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        "sess-missing",
        makeFsHandle(),
        dir,
      );
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns absolute paths of agent-*.jsonl files and excludes non-matching files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-subagents-"));
    try {
      const encodedCwd = encodeProjectPath("/sandbox/repo");
      const subagentsDir = join(dir, encodedCwd, "sess-1", "subagents");
      await mkdir(subagentsDir, { recursive: true });
      await writeFile(join(subagentsDir, "agent-abc.jsonl"), "{}");
      await writeFile(join(subagentsDir, "agent-def.jsonl"), "{}");
      await writeFile(join(subagentsDir, "notes.txt"), "ignored");
      await writeFile(join(subagentsDir, "main.jsonl"), "ignored");

      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        "sess-1",
        makeFsHandle(),
        dir,
      );

      expect(result.sort()).toEqual(
        [
          join(subagentsDir, "agent-abc.jsonl"),
          join(subagentsDir, "agent-def.jsonl"),
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] (not a throw) when the encoded-cwd dir exists but has no subagents/ subdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-subagents-"));
    try {
      const encodedCwd = encodeProjectPath("/sandbox/repo");
      await mkdir(join(dir, encodedCwd, "sess-1"), { recursive: true });

      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        "sess-1",
        makeFsHandle(),
        dir,
      );
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
