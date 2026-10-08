/**
 * Session JSONL transfer primitives.
 *
 * The transfer functions are pure: they take a JSONL string and the source/
 * target cwds, and return the rewritten JSONL string. Call sites do their own
 * file I/O (reading the source, writing the destination). Per ADR 0012, the
 * cwd rewrite is specific to each agent's JSONL format, so each agent owns
 * its own transfer function.
 */

import { access, readdir } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

// ---------------------------------------------------------------------------
// Host session lookup
// ---------------------------------------------------------------------------

/**
 * Result of locating a session on the host by its unique id, independent of any
 * cwd-derived path encoding.
 */
export interface HostSessionLookup {
  /** Absolute path to the located session file, or `undefined` when no session
   *  with this id exists anywhere under the searched root. */
  readonly path: string | undefined;
  /** The host directory that was scanned — surfaced in not-found errors so the
   *  user knows where Sandcastle looked. */
  readonly searchedRoot: string;
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Claude Code session paths and transfer
// ---------------------------------------------------------------------------

/**
 * Encode a cwd into the Claude Code `~/.claude/projects/<encoded>/` layout.
 * Replaces path separators with hyphens, matching Claude Code's convention.
 */
export const encodeProjectPath = (cwd: string): string => {
  const isRoot = cwd === "/" || /^[A-Za-z]:[\\/]?$/.test(cwd);
  const normalized = isRoot ? cwd : cwd.replace(/[\\/]+$/, "");
  return normalized.replace(/^([A-Za-z]):/, "$1").replace(/[\\/]/g, "-");
};

/** Absolute host path to a Claude session JSONL file. */
export const claudeHostSessionPath = (
  cwd: string,
  id: string,
  projectsDir?: string,
): string => {
  const base =
    projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  return join(base, encodeProjectPath(cwd), `${id}.jsonl`);
};

/** Sandbox-side path to a Claude session JSONL file (always POSIX separators). */
export const claudeSandboxSessionPath = (
  cwd: string,
  id: string,
  projectsDir: string,
): string => posix.join(projectsDir, encodeProjectPath(cwd), `${id}.jsonl`);

/**
 * Sandbox-side path to the directory holding subagent / workflow transcripts
 * for a given Claude Code session, following Claude Code's
 * `<projectsDir>/<encoded-cwd>/<sessionId>/subagents/` layout. POSIX
 * separators so it works on Windows hosts driving Linux containers.
 */
export const claudeSubagentsDirInSandbox = (
  cwd: string,
  id: string,
  projectsDir: string,
): string => posix.join(projectsDir, encodeProjectPath(cwd), id, "subagents");

/**
 * Host-side path to the directory holding subagent / workflow transcripts for
 * a given Claude Code session. Defaults to `~/.claude/projects` when no
 * `projectsDir` is provided.
 */
export const claudeSubagentsDirOnHost = (
  cwd: string,
  id: string,
  projectsDir?: string,
): string => {
  const base =
    projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  return join(base, encodeProjectPath(cwd), id, "subagents");
};

/**
 * Enumerate Claude Code subagent / workflow transcripts (`agent-*.jsonl`,
 * matched at any depth so future per-workflow subdirs still surface) under a
 * known `subagents/` directory inside the sandbox.
 *
 * Never throws — a missing `subagents/` directory is the normal case for a
 * session that didn't spawn any subagents, and `find` over an absent path
 * also exits non-zero. Both collapse to `[]`.
 */
export const listClaudeSubagentSessionsInDir = async (
  subagentsDir: string,
  handle: Pick<BindMountSandboxHandle, "exec">,
): Promise<string[]> => {
  const result = await handle.exec(
    `find ${JSON.stringify(subagentsDir)} -type f -name ${JSON.stringify("agent-*.jsonl")} 2>/dev/null`,
  );
  if (result.exitCode !== 0) return [];
  const stdout = result.stdout.trim();
  if (stdout === "") return [];
  return stdout.split("\n").filter((line) => line !== "");
};

/**
 * Enumerate Claude Code subagent / workflow transcripts for a session whose
 * `subagents/` directory is reconstructed from `(cwd, id)`. Prefer
 * {@link listClaudeSubagentSessionsInDir} with a directory derived from the
 * located main-session path when available, since that sidesteps cwd-encoding
 * drift.
 */
export const listClaudeSubagentSessionsInSandbox = async (
  cwd: string,
  id: string,
  handle: Pick<BindMountSandboxHandle, "exec">,
  sandboxProjectsDir: string,
): Promise<string[]> =>
  listClaudeSubagentSessionsInDir(
    claudeSubagentsDirInSandbox(cwd, id, sandboxProjectsDir),
    handle,
  );

/**
 * Locate a Claude Code session JSONL inside the sandbox by its unique id,
 * scanning `<sandboxProjectsDir>/` rather than reconstructing the
 * `<encoded-cwd>` directory via {@link encodeProjectPath}. Claude Code derives
 * that directory from its own cwd-encoding rules, which collapse more than path
 * separators (e.g. `.` → `-`); reconstructing it on the host drifts whenever
 * Claude's encoding changes and produces "session not found in container"
 * capture failures. The session id is globally unique, so the first match wins.
 *
 * Throws when no match exists — the main session file is expected to be present
 * once the agent has produced a session id.
 */
export const locateClaudeSandboxSession = async (
  id: string,
  handle: Pick<BindMountSandboxHandle, "exec">,
  sandboxProjectsDir: string,
): Promise<string> => {
  const result = await handle.exec(
    `find ${JSON.stringify(sandboxProjectsDir)} -type f -name ${JSON.stringify(`${id}.jsonl`)} -print -quit`,
  );
  const path = result.stdout.trim().split("\n")[0];
  if (result.exitCode !== 0 || !path) {
    throw new Error(`session ${id} not found under ${sandboxProjectsDir}`);
  }
  return path;
};

/**
 * Locate a Claude Code session JSONL on the host by its unique id, scanning each
 * `~/.claude/projects/<encoded-cwd>/` directory rather than reconstructing the
 * cwd encoding. The session id is globally unique, so the first match wins.
 */
export const findClaudeSessionOnHost = async (
  id: string,
  projectsDir?: string,
): Promise<HostSessionLookup> => {
  const root =
    projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { path: undefined, searchedRoot: root };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${id}.jsonl`);
    if (await pathExists(candidate)) {
      return { path: candidate, searchedRoot: root };
    }
  }
  return { path: undefined, searchedRoot: root };
};

const rewriteSessionCwd = (
  content: string,
  fromCwd: string,
  toCwd: string,
): string => {
  if (content === "") return "";
  return content
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      // A torn final line (writer killed mid-flush) must not abort the whole
      // transfer — preserve it verbatim so the rest of the session survives.
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (typeof entry.cwd === "string" && entry.cwd === fromCwd) {
          entry.cwd = toCwd;
        }
        if (
          entry.type === "session_meta" &&
          typeof entry.payload === "object" &&
          entry.payload !== null &&
          typeof (entry.payload as { cwd?: unknown }).cwd === "string" &&
          (entry.payload as { cwd: string }).cwd === fromCwd
        ) {
          (entry.payload as { cwd: string }).cwd = toCwd;
        }
        return JSON.stringify(entry);
      } catch {
        return line;
      }
    })
    .join("\n");
};

/**
 * Rewrite a Claude Code session JSONL string, replacing `cwd` fields that
 * match `fromCwd` with `toCwd`. Pure function — no file I/O.
 */
export const transferClaudeSession = (
  jsonl: string,
  fromCwd: string,
  toCwd: string,
): string => rewriteSessionCwd(jsonl, fromCwd, toCwd);

// ---------------------------------------------------------------------------
// Codex session paths and transfer
// ---------------------------------------------------------------------------

const isCodexSessionFilename = (filename: string, id: string): boolean =>
  filename.startsWith("rollout-") && filename.endsWith(`-${id}.jsonl`);

const findCodexSessionPath = async (
  rootDir: string,
  id: string,
): Promise<string | undefined> => {
  const visit = async (dir: string): Promise<string | undefined> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isFile() && isCodexSessionFilename(entry.name, id)) {
        return child;
      }
      if (entry.isDirectory()) {
        const found = await visit(child);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(rootDir);
};

/**
 * Locate a Codex session rollout file on the host by its id, reusing the
 * date-nested scan.
 */
export const findCodexSessionOnHost = async (
  id: string,
  sessionsDir?: string,
): Promise<HostSessionLookup> => {
  const root =
    sessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
  const path = await findCodexSessionPath(root, id);
  return { path, searchedRoot: root };
};

/** Codex host session lookup that also returns the relative date-nested path. */
export interface CodexSessionLocation {
  readonly path: string;
  readonly relativePath: string;
}

export const locateCodexHostSession = async (
  id: string,
  sessionsDir?: string,
): Promise<CodexSessionLocation> => {
  const root =
    sessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
  const path = await findCodexSessionPath(root, id);
  if (!path) throw new Error(`session ${id} not found in ${root}`);
  return { path, relativePath: relative(root, path) };
};

export const locateCodexSandboxSession = async (
  id: string,
  handle: Pick<BindMountSandboxHandle, "exec">,
  sessionsDir: string,
): Promise<CodexSessionLocation> => {
  const result = await handle.exec(
    `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(`rollout-*-${id}.jsonl`)} -print -quit`,
  );
  const path = result.stdout.trim().split("\n")[0];
  if (result.exitCode !== 0 || !path) {
    throw new Error(`session ${id} not found in ${sessionsDir}`);
  }
  return { path, relativePath: posix.relative(sessionsDir, path) };
};

/**
 * Rewrite a Codex session JSONL string, replacing `cwd` fields (both top-level
 * and `session_meta.payload.cwd`) that match `fromCwd` with `toCwd`. Pure
 * function — no file I/O.
 */
export const transferCodexSession = (
  jsonl: string,
  fromCwd: string,
  toCwd: string,
): string => rewriteSessionCwd(jsonl, fromCwd, toCwd);

// ---------------------------------------------------------------------------
// Pi session paths and transfer
// ---------------------------------------------------------------------------

/**
 * Encode a cwd into pi's `~/.pi/agent/sessions/<encoded>/` layout. Pi strips the
 * leading separator and replaces path separators / drive colons with `-`, then
 * wraps the result in `--` markers. Mirrors `@mariozechner/pi-agent-core`'s
 * `SessionManager` directory encoding (verified against pi 0.73.1).
 */
export const encodePiSessionDir = (cwd: string): string => {
  const stripped = cwd.replace(/^[/\\]/, "");
  const replaced = stripped.replace(/[/\\:]/g, "-");
  return `--${replaced}--`;
};

/** Absolute host path to the pi session directory for a given cwd. */
export const piSessionDirPath = (cwd: string, sessionsDir?: string): string => {
  const base =
    sessionsDir ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
  return join(base, encodePiSessionDir(cwd));
};

const isPiSessionFilename = (filename: string, id: string): boolean =>
  filename.endsWith(`_${id}.jsonl`);

const findPiSessionPath = async (
  rootDir: string,
  id: string,
): Promise<{ path: string; relativePath: string } | undefined> => {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirAbs = join(rootDir, entry.name);
    let files;
    try {
      files = await readdir(dirAbs);
    } catch {
      continue;
    }
    const match = files.find((name) => isPiSessionFilename(name, id));
    if (match) {
      return {
        path: join(dirAbs, match),
        relativePath: join(entry.name, match),
      };
    }
  }
  return undefined;
};

/**
 * Locate a pi session JSONL on the host by its id, scanning each
 * `--<encoded-cwd>--/` directory under `~/.pi/agent/sessions/`.
 */
export const findPiSessionOnHost = async (
  id: string,
  sessionsDir?: string,
): Promise<HostSessionLookup> => {
  const root =
    sessionsDir ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
  const found = await findPiSessionPath(root, id);
  return { path: found?.path, searchedRoot: root };
};

/** Pi host session lookup that also returns the relative `--enc-cwd--/file` path. */
export interface PiSessionLocation {
  readonly path: string;
  readonly relativePath: string;
}

export const locatePiHostSession = async (
  id: string,
  sessionsDir?: string,
): Promise<PiSessionLocation> => {
  const root =
    sessionsDir ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
  const found = await findPiSessionPath(root, id);
  if (!found) throw new Error(`session ${id} not found in ${root}`);
  return found;
};

export const locatePiSandboxSession = async (
  id: string,
  handle: Pick<BindMountSandboxHandle, "exec">,
  sessionsDir: string,
): Promise<PiSessionLocation> => {
  const result = await handle.exec(
    `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(`*_${id}.jsonl`)} -print -quit`,
  );
  const path = result.stdout.trim().split("\n")[0];
  if (result.exitCode !== 0 || !path) {
    throw new Error(`session ${id} not found in ${sessionsDir}`);
  }
  return { path, relativePath: posix.relative(sessionsDir, path) };
};

/**
 * Rewrite a pi session JSONL string, replacing the `cwd` field on the header
 * `session` entry (the only line in pi's JSONL that carries the working
 * directory) when it matches `fromCwd`. Pure function — no file I/O.
 *
 * Pi loads sessions with `assertSessionCwdExists`; in print/json mode a missing
 * cwd terminates the process. The header rewrite is therefore load-bearing for
 * resume, not cosmetic.
 */
export const transferPiSession = (
  jsonl: string,
  fromCwd: string,
  toCwd: string,
): string => {
  if (jsonl === "") return "";
  return jsonl
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (
          entry.type === "session" &&
          typeof entry.cwd === "string" &&
          entry.cwd === fromCwd
        ) {
          entry.cwd = toCwd;
          return JSON.stringify(entry);
        }
        return line;
      } catch {
        return line;
      }
    })
    .join("\n");
};
