import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeHostSessionPath, encodeProjectPath } from "@ai-hero/sandcastle";

// Expected values were confirmed against real Claude Code 2.1.316 runs
// (`claude -p` from each directory, then listing ~/.claude/projects).

describe("encodeProjectPath matches Claude Code's project directory names", () => {
  it("replaces the dots in a host-path worktree under .sandcastle/worktrees", () => {
    expect(
      encodeProjectPath(
        "/home/me/repo/.sandcastle/worktrees/sandcastle_2026.x",
      ),
    ).toBe("-home-me-repo--sandcastle-worktrees-sandcastle-2026-x");
  });

  it("replaces every character that isn't an ASCII letter or digit", () => {
    expect(encodeProjectPath("/tmp/sp ace/ü~@+=,dir")).toBe(
      "-tmp-sp-ace-------dir",
    );
  });

  it("truncates a long name to 200 characters and appends Claude Code's hash", () => {
    const long = `/tmp/enc-5jbL/${"a".repeat(120)}/${"b".repeat(120)}`;
    const encoded = encodeProjectPath(long);

    expect(encoded).toBe(
      `-tmp-enc-5jbL-${"a".repeat(120)}-${"b".repeat(65)}-oy0ktj`,
    );
  });

  it("replaces a Windows drive colon, as Claude Code does", () => {
    expect(encodeProjectPath(String.raw`C:\Users\me\my.app`)).toBe(
      "C--Users-me-my-app",
    );
  });

  it("puts the session file under the encoded directory", () => {
    expect(
      claudeHostSessionPath(
        "/home/me/repo/.sandcastle/worktrees/wt",
        "abc",
        "/projects",
      ),
    ).toBe(
      // Claude Code keeps sessions under the OS-native ~/.claude/projects,
      // so the separators are the platform's.
      path.join(
        "/projects",
        "-home-me-repo--sandcastle-worktrees-wt",
        "abc.jsonl",
      ),
    );
  });
});
