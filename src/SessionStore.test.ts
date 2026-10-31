import { assert, describe, expect, it } from "vitest";
import {
  claudeSubagentsDirInSandbox,
  claudeSubagentsDirOnHost,
  encodePiSessionDir,
  encodeProjectPath,
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
  findPiSessionOnHost,
  listClaudeSubagentSessionsInSandbox,
  makeSessionFileStorage,
  piSessionDirPath,
  transferClaudeSession,
  transferCodexSession,
  transferPiSession,
} from "./SessionStore.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

/** Parses one line of a JSONL transcript, failing the test if the line is missing. */
const parseLine = (lines: readonly string[], index: number): unknown => {
  const line = lines[index];
  assert.isDefined(line, `expected a line at index ${index}`);
  return JSON.parse(line);
};

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
    expect(encodeProjectPath(String.raw`D:\projektit\super-app`)).toBe(
      "D--projektit-super-app",
    );
  });

  it("strips trailing backslash before encoding", () => {
    expect(encodeProjectPath("C:\\Users\\rootti\\repos\\foo\\")).toBe(
      "C--Users-rootti-repos-foo",
    );
  });

  it("encodes Windows drive root", () => {
    expect(encodeProjectPath("C:\\")).toBe("C--");
  });

  it("encodes drive letter without trailing separator", () => {
    expect(encodeProjectPath("C:")).toBe("C-");
  });

  it("strips multiple trailing backslashes", () => {
    expect(encodeProjectPath(String.raw`D:\projekts\app\\`)).toBe(
      "D--projekts-app",
    );
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

    expect(parseLine(lines, 0)).toStrictEqual({
      type: "system",
      cwd: "/home/user/repos/project",
    });
    expect(parseLine(lines, 1)).toStrictEqual({
      type: "message",
      content: "hello",
    });
    expect(parseLine(lines, 2)).toStrictEqual({
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
    expect(parseLine(lines, 0)).toMatchObject({ cwd: "/host/repo" });
    expect(parseLine(lines, 1)).toMatchObject({ cwd: "/other/path" });
  });

  it("preserves a malformed line verbatim instead of aborting the rewrite", () => {
    // A partially-written final line (torn write during capture) must not
    // poison the whole transfer — the surrounding good lines are rewritten
    // as usual, the bad line round-trips byte-for-byte.
    const torn = '{"type":"system","cwd":"/sandbox/worktree"'; // missing closing brace
    const jsonl = [
      JSON.stringify({ type: "a", cwd: "/sandbox/worktree" }),
      torn,
      JSON.stringify({ type: "b", cwd: "/sandbox/worktree" }),
    ].join("\n");

    const out = transferClaudeSession(jsonl, "/sandbox/worktree", "/host/repo");
    const lines = out.split("\n");
    expect(parseLine(lines, 0)).toMatchObject({ cwd: "/host/repo" });
    expect(lines[1]).toBe(torn);
    expect(parseLine(lines, 2)).toMatchObject({ cwd: "/host/repo" });
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
    expect(parseLine(lines, 0)).toMatchObject({
      payload: { cwd: "/host/repo" },
    });
    expect(parseLine(lines, 1)).toMatchObject({ cwd: "/host/repo" });
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
// findCodexSessionOnHost
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
    expect(encodePiSessionDir(String.raw`C:\repos\my-app`)).toBe(
      "--C--repos-my-app--",
    );
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

    expect(parseLine(lines, 0)).toMatchObject({ cwd: "/host/repo" });
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

    expect(parseLine(lines, 0)).toMatchObject({ cwd: "/host/repo" });
    expect(parseLine(lines, 1)).toMatchObject({ cwd: "/sandbox/repo" });
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
// findPiSessionOnHost
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

// ---------------------------------------------------------------------------
// Claude subagent / workflow session helpers
// ---------------------------------------------------------------------------

describe("claudeSubagentsDirInSandbox", () => {
  it("returns <projectsDir>/<encoded-cwd>/<sessionId>/subagents using POSIX separators", () => {
    expect(
      claudeSubagentsDirInSandbox(
        "/sandbox/repo",
        "abc-123",
        "/home/agent/.claude/projects",
      ),
    ).toBe("/home/agent/.claude/projects/-sandbox-repo/abc-123/subagents");
  });
});

describe("claudeSubagentsDirOnHost", () => {
  it("returns <projectsDir>/<encoded-cwd>/<sessionId>/subagents using host separators", () => {
    expect(
      claudeSubagentsDirOnHost("/host/repo", "abc-123", "/tmp/projects"),
    ).toBe(join("/tmp/projects", "-host-repo", "abc-123", "subagents"));
  });
});

describe("listClaudeSubagentSessionsInSandbox", () => {
  /** Bind-mount handle backed by the host filesystem (sandbox path == host path). */
  const fsHandle = (): Pick<BindMountSandboxHandle, "exec"> => ({
    exec: async (command) => {
      const { exec } = await import("node:child_process");
      return new Promise((resolve) => {
        exec(command, (err, stdout, stderr) => {
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err && typeof err.code === "number" ? err.code : 0,
          });
        });
      });
    },
  });

  it("returns absolute paths of agent-*.jsonl files in the subagents dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-sub-list-"));
    try {
      const sessionId = "abc-123";
      const subagentsDir = join(dir, "-sandbox-repo", sessionId, "subagents");
      await mkdir(subagentsDir, { recursive: true });
      const f1 = join(subagentsDir, "agent-alpha.jsonl");
      const f2 = join(subagentsDir, "agent-beta.jsonl");
      await writeFile(f1, "{}");
      await writeFile(f2, "{}");
      // Non-matching files must be filtered out by the find pattern.
      await writeFile(join(subagentsDir, "summary.txt"), "irrelevant");
      await writeFile(join(subagentsDir, "agent-gamma.json"), "{}");

      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        sessionId,
        fsHandle(),
        dir,
      );

      expect(result.sort()).toStrictEqual([f1, f2].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the subagents dir does not exist (the normal case)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-sub-nodir-"));
    try {
      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        "abc-123",
        fsHandle(),
        dir,
      );
      expect(result).toStrictEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the subagents dir is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-sub-empty-"));
    try {
      const subagentsDir = join(dir, "-sandbox-repo", "abc-123", "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const result = await listClaudeSubagentSessionsInSandbox(
        "/sandbox/repo",
        "abc-123",
        fsHandle(),
        dir,
      );
      expect(result).toStrictEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses POSIX path semantics for the sandbox-side enumeration", () => {
    // Sanity-check: the dir helper used inside the listing must emit POSIX
    // separators so it works on Windows hosts driving Linux containers.
    expect(
      claudeSubagentsDirInSandbox(
        "/sandbox/repo",
        "abc-123",
        "/sandbox/projects",
      ),
    ).toContain(posix.sep);
  });
});

// ---------------------------------------------------------------------------
// makeSessionFileStorage
// ---------------------------------------------------------------------------

describe("makeSessionFileStorage", () => {
  /** A bind-mount handle whose "sandbox" is a directory on this machine. */
  const localHandle = (): BindMountSandboxHandle => ({
    worktreePath: "/workspace",
    exec: async (command, options) => {
      const { execSync } = await import("node:child_process");
      try {
        const stdout = execSync(command, {
          input: options?.stdin,
          encoding: "utf8",
        });
        return { stdout, stderr: "", exitCode: 0 };
      } catch {
        return { stdout: "", stderr: "failed", exitCode: 1 };
      }
    },
    copyFileIn: async (hostPath, sandboxPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(hostPath, sandboxPath);
    },
    copyFileOut: async (sandboxPath, hostPath) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(sandboxPath, hostPath);
    },
    close: async () => {},
  });

  const withDirs = async (
    test: (dirs: { host: string; sandbox: string }) => Promise<void>,
  ): Promise<void> => {
    const host = await mkdtemp(join(tmpdir(), "sandcastle-sfs-host-"));
    const sandbox = await mkdtemp(join(tmpdir(), "sandcastle-sfs-sbx-"));
    try {
      await test({ host, sandbox });
    } finally {
      await rm(host, { recursive: true, force: true });
      await rm(sandbox, { recursive: true, force: true });
    }
  };

  const layoutFor = (
    dirs: { host: string; sandbox: string },
    rewrite?: (content: string, from: string, to: string) => string,
  ) => ({
    hostRoot: dirs.host,
    hostPath: (_cwd: string, id: string) => join(dirs.host, id, "s.log"),
    hostPathsById: (id: string) => [join(dirs.host, id, "s.log")],
    sandboxPath: (_cwd: string, id: string) =>
      posix.join(dirs.sandbox, id, "s.log"),
    rewrite,
  });

  const swap = (content: string, from: string, to: string): string =>
    content.replaceAll(from, to);

  it("captures the sandbox file to the host, rewritten", async () => {
    await withDirs(async (dirs) => {
      await mkdir(join(dirs.sandbox, "s1"), { recursive: true });
      await writeFile(join(dirs.sandbox, "s1", "s.log"), "cwd=/sbx\n");
      const storage = makeSessionFileStorage(layoutFor(dirs, swap));

      await storage.captureToHost({
        hostCwd: "/host",
        sandboxCwd: "/sbx",
        sessionId: "s1",
        handle: localHandle(),
      });

      await expect(storage.readHostSession("/host", "s1")).resolves.toBe(
        "cwd=/host\n",
      );
      await expect(storage.existsOnHost("/host", "s1")).resolves.toBe(true);
      await expect(storage.findByIdOnHost("s1")).resolves.toStrictEqual({
        path: join(dirs.host, "s1", "s.log"),
        searchedRoot: dirs.host,
      });
    });
  });

  it("resumes the host file into the sandbox, rewritten", async () => {
    await withDirs(async (dirs) => {
      await mkdir(join(dirs.host, "s2"), { recursive: true });
      await writeFile(join(dirs.host, "s2", "s.log"), "cwd=/host\n");
      const storage = makeSessionFileStorage(layoutFor(dirs, swap));

      await storage.resumeIntoSandbox({
        hostCwd: "/host",
        sandboxCwd: "/sbx",
        sessionId: "s2",
        handle: localHandle(),
      });

      await expect(
        readFile(join(dirs.sandbox, "s2", "s.log"), "utf8"),
      ).resolves.toBe("cwd=/sbx\n");
    });
  });

  it("copies the file byte for byte both ways when there is no rewrite", async () => {
    await withDirs(async (dirs) => {
      const bytes = Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff, 0xfe, 0x0a]);
      await mkdir(join(dirs.sandbox, "s3"), { recursive: true });
      await writeFile(join(dirs.sandbox, "s3", "s.log"), bytes);
      const storage = makeSessionFileStorage(layoutFor(dirs));
      const transfer = {
        hostCwd: "/host",
        sandboxCwd: "/sbx",
        sessionId: "s3",
        handle: localHandle(),
      };

      await storage.captureToHost(transfer);
      await rm(join(dirs.sandbox, "s3"), { recursive: true });
      await storage.resumeIntoSandbox(transfer);

      await expect(
        readFile(join(dirs.host, "s3", "s.log")),
      ).resolves.toStrictEqual(bytes);
      await expect(
        readFile(join(dirs.sandbox, "s3", "s.log")),
      ).resolves.toStrictEqual(bytes);
    });
  });

  it("finds a session by id in any subdirectory the layout names", async () => {
    await withDirs(async (dirs) => {
      await mkdir(join(dirs.host, "cwd-b", "s4"), { recursive: true });
      await writeFile(join(dirs.host, "cwd-b", "s4", "s.log"), "x");
      const storage = makeSessionFileStorage({
        ...layoutFor(dirs),
        hostPathsById: (id, subdirs) =>
          subdirs.map((subdir) => join(dirs.host, subdir, id, "s.log")),
      });
      await expect(storage.findByIdOnHost("s4")).resolves.toStrictEqual({
        path: join(dirs.host, "cwd-b", "s4", "s.log"),
        searchedRoot: dirs.host,
      });
    });
  });

  it("reports a missing session with the searched root", async () => {
    await withDirs(async (dirs) => {
      const storage = makeSessionFileStorage(layoutFor(dirs));
      await expect(storage.existsOnHost("/host", "nope")).resolves.toBe(false);
      await expect(
        storage.readHostSession("/host", "nope"),
      ).resolves.toBeUndefined();
      await expect(storage.findByIdOnHost("nope")).resolves.toStrictEqual({
        path: undefined,
        searchedRoot: dirs.host,
      });
    });
  });
});
