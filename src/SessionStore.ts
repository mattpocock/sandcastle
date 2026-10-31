/**
 * Session JSONL transfer primitives.
 *
 * The transfer functions are pure: they take a JSONL string and the source/
 * target cwds, and return the rewritten JSONL string. Call sites do their own
 * file I/O (reading the source, writing the destination). Per ADR 0012, the
 * cwd rewrite is specific to each agent's JSONL format, so each agent owns
 * its own transfer function.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { BindMountSandboxHandle, ExecResult } from "./SandboxProvider.js";

/** The host user's home directory, where every agent keeps its sessions. */
export const homeDir = (): string => process.env.HOME ?? "~";

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

/** The first of `paths` that exists, checked in order, or `undefined`. */
export const firstExistingPath = async (
  paths: readonly string[],
): Promise<string | undefined> => {
  const [head, ...rest] = paths;
  if (head === undefined) {
    return undefined;
  }
  return (await pathExists(head)) ? head : firstExistingPath(rest);
};

/** Whether a file or directory exists at `path`. */
export const pathExists = async (path: string): Promise<boolean> => {
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
  return normalized.replace(/^([A-Za-z]):/, "$1").replaceAll(/[\\/]/g, "-");
};

/** Absolute host path to a Claude session JSONL file. */
export const claudeHostSessionPath = (
  cwd: string,
  id: string,
  projectsDir?: string,
): string => {
  const base = projectsDir ?? join(homeDir(), ".claude", "projects");
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
  const base = projectsDir ?? join(homeDir(), ".claude", "projects");
  return join(base, encodeProjectPath(cwd), id, "subagents");
};

/**
 * Enumerate Claude Code subagent / workflow transcripts living under
 * `<projectsDir>/<encoded-cwd>/<sessionId>/subagents/` inside the sandbox.
 * Returns the absolute sandbox-side paths of every `agent-*.jsonl` file
 * (matched at any depth so future per-workflow subdirs still surface).
 *
 * Never throws — a missing `subagents/` directory is the normal case for a
 * session that didn't spawn any subagents, and `find` over an absent path
 * also exits non-zero. Both collapse to `[]`.
 */
export const listClaudeSubagentSessionsInSandbox = async (
  cwd: string,
  id: string,
  handle: Pick<BindMountSandboxHandle, "exec">,
  sandboxProjectsDir: string,
): Promise<string[]> => {
  const dir = claudeSubagentsDirInSandbox(cwd, id, sandboxProjectsDir);
  const result = await handle.exec(
    `find ${JSON.stringify(dir)} -type f -name ${JSON.stringify("agent-*.jsonl")} 2>/dev/null`,
  );
  if (result.exitCode !== 0) {
    return [];
  }
  const stdout = result.stdout.trim();
  if (stdout === "") {
    return [];
  }
  return stdout.split("\n").filter((line) => line !== "");
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
  const root = projectsDir ?? join(homeDir(), ".claude", "projects");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { path: undefined, searchedRoot: root };
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, `${id}.jsonl`));
  return { path: await firstExistingPath(candidates), searchedRoot: root };
};

/**
 * Point one session entry at `toCwd`: its own `cwd`, and the `payload.cwd` of
 * a Codex `session_meta` entry, when either is `fromCwd`.
 */
const rewriteEntryCwd = (
  entry: Record<string, unknown>,
  fromCwd: string,
  toCwd: string,
): void => {
  if (typeof entry.cwd === "string" && entry.cwd === fromCwd) {
    entry.cwd = toCwd;
  }
  if (
    entry.type === "session_meta" &&
    isRecord(entry.payload) &&
    typeof entry.payload.cwd === "string" &&
    entry.payload.cwd === fromCwd
  ) {
    entry.payload.cwd = toCwd;
  }
};

const rewriteSessionCwd = (
  content: string,
  fromCwd: string,
  toCwd: string,
): string => {
  if (content === "") {
    return "";
  }
  return content
    .split("\n")
    .map((line) => {
      if (line === "") {
        return line;
      }
      // A torn final line (writer killed mid-flush) must not abort the whole
      // transfer — preserve it verbatim so the rest of the session survives.
      try {
        const entry: unknown = JSON.parse(line);
        if (!isRecord(entry)) {
          return line;
        }
        rewriteEntryCwd(entry, fromCwd, toCwd);
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

/**
 * Locate a Codex session rollout file on the host by its id, scanning the
 * date-nested `YYYY/MM/DD/` directories depth-first.
 */
export const findCodexSessionOnHost = async (
  id: string,
  sessionsDir?: string,
): Promise<HostSessionLookup> => {
  const root = sessionsDir ?? join(homeDir(), ".codex", "sessions");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { path: undefined, searchedRoot: root };
  }
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isFile() && isCodexSessionFilename(entry.name, id)) {
      return { path: child, searchedRoot: root };
    }
    if (entry.isDirectory()) {
      const { path } = await findCodexSessionOnHost(id, child);
      if (path !== undefined) {
        return { path, searchedRoot: root };
      }
    }
  }
  return { path: undefined, searchedRoot: root };
};

/**
 * The path of a session found on the host, or a not-found error naming the
 * directory searched. For resume, where the precheck already found it.
 */
export const requireHostSessionPath = (
  found: HostSessionLookup,
  id: string,
): string => {
  if (found.path === undefined) {
    throw new Error(`session ${id} not found in ${found.searchedRoot}`);
  }
  return found.path;
};

/** A session file found in the sandbox, with its path relative to the sessions dir. */
export interface SandboxSessionLocation {
  readonly path: string;
  readonly relativePath: string;
}

/**
 * Locate a session file in the sandbox by its file-name glob (codex:
 * `rollout-*-<id>.jsonl`, pi: `*_<id>.jsonl`), scanning `sessionsDir`.
 */
export const locateSandboxSessionFile = async (
  handle: Pick<BindMountSandboxHandle, "exec">,
  sessionsDir: string,
  nameGlob: string,
): Promise<SandboxSessionLocation> => {
  const result = await handle.exec(
    `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(nameGlob)} -print -quit`,
  );
  const [path = ""] = result.stdout.trim().split("\n");
  if (result.exitCode !== 0 || path === "") {
    throw new Error(`session ${nameGlob} not found in ${sessionsDir}`);
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
  const replaced = stripped.replaceAll(/[/\\:]/g, "-");
  return `--${replaced}--`;
};

/** Absolute host path to the pi session directory for a given cwd. */
export const piSessionDirPath = (cwd: string, sessionsDir?: string): string => {
  const base = sessionsDir ?? join(homeDir(), ".pi", "agent", "sessions");
  return join(base, encodePiSessionDir(cwd));
};

const isPiSessionFilename = (filename: string, id: string): boolean =>
  filename.endsWith(`_${id}.jsonl`);

/**
 * Locate a pi session JSONL on the host by its id, scanning each
 * `--<encoded-cwd>--/` directory under `~/.pi/agent/sessions/`.
 */
export const findPiSessionOnHost = async (
  id: string,
  sessionsDir?: string,
): Promise<HostSessionLookup> => {
  const root = sessionsDir ?? join(homeDir(), ".pi", "agent", "sessions");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { path: undefined, searchedRoot: root };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirAbs = join(root, entry.name);
    let files;
    try {
      files = await readdir(dirAbs);
    } catch {
      continue;
    }
    const match = files.find((name) => isPiSessionFilename(name, id));
    if (match !== undefined) {
      return { path: join(dirAbs, match), searchedRoot: root };
    }
  }
  return { path: undefined, searchedRoot: root };
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
  if (jsonl === "") {
    return "";
  }
  return jsonl
    .split("\n")
    .map((line) => {
      if (line === "") {
        return line;
      }
      try {
        const entry: unknown = JSON.parse(line);
        if (
          isRecord(entry) &&
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

/** A parsed JSON value that is an object (or array), so its fields can be read. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// ---------------------------------------------------------------------------
// Copilot session paths and transfer
// ---------------------------------------------------------------------------

/**
 * Copilot keeps each session in `~/.copilot/session-state/<id>/`, keyed by id
 * alone. Its `events.jsonl` is the whole conversation: `copilot --resume=<id>`
 * replays it with no other file present, not even the `session-store.db`
 * index beside it (verified with Copilot CLI 1.0.105).
 */
export const copilotSessionPath = (sessionsDir: string, id: string): string =>
  posix.join(sessionsDir, id, "events.jsonl");

/** The host's default Copilot `session-state` directory. */
export const copilotHostSessionsDir = (): string =>
  join(homeDir(), ".copilot", "session-state");

/** Rewrite one event's `data.context.cwd` / `gitRoot`; the line itself when untouched. */
const rewriteCopilotEvent = (
  line: string,
  fromCwd: string,
  toCwd: string,
): string => {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return line;
  }
  const data = isRecord(entry) ? entry["data"] : undefined;
  const context = isRecord(data) ? data["context"] : undefined;
  if (!isRecord(context)) {
    return line;
  }
  const keys = ["cwd", "gitRoot"].filter((key) => context[key] === fromCwd);
  for (const key of keys) {
    context[key] = toCwd;
  }
  return keys.length > 0 ? JSON.stringify(entry) : line;
};

/**
 * Rewrite a Copilot `events.jsonl` string, replacing the structured
 * `data.context.cwd` / `data.context.gitRoot` fields that match `fromCwd` with
 * `toCwd`. Free text (the system prompt names the cwd too) is left alone, and
 * a torn line is kept verbatim. Pure function — no file I/O.
 */
export const transferCopilotSession = (
  jsonl: string,
  fromCwd: string,
  toCwd: string,
): string =>
  jsonl
    .split("\n")
    .map((line) =>
      line === "" ? line : rewriteCopilotEvent(line, fromCwd, toCwd),
    )
    .join("\n");

// ---------------------------------------------------------------------------
// Cursor session paths
// ---------------------------------------------------------------------------

/**
 * Cursor keeps each chat in `~/.cursor/chats/<md5 of the cwd>/<chat id>/`.
 * Its `store.db` (SQLite) is the whole conversation: `agent --resume <id>`
 * replays it with no other file present, and rebuilds `meta.json` itself
 * (verified with Cursor Agent CLI 2026.10.22).
 */
export const cursorChatDirName = (cwd: string): string =>
  createHash("md5").update(cwd).digest("hex");

/** The host's default Cursor `chats` directory. */
export const cursorHostChatsDir = (): string =>
  join(homeDir(), ".cursor", "chats");

// ---------------------------------------------------------------------------
// OpenCode session paths
// ---------------------------------------------------------------------------

/**
 * OpenCode keeps sessions in its SQLite database (`opencode.db`), so there is
 * no per-session file to copy. Sandcastle moves the session as the JSON of
 * `opencode export <id>` instead, and keeps it on the host here, where
 * `opencode import <file>` also reads it.
 */
export const opencodeHostSessionsDir = (): string =>
  join(homeDir(), ".local", "share", "opencode", "sandcastle-sessions");

/** OpenCode's own database on the host, where a no-sandbox run keeps its sessions. */
export const opencodeHostDatabase = (): string =>
  join(homeDir(), ".local", "share", "opencode", "opencode.db");

// ---------------------------------------------------------------------------
// Session storage for agents that keep each session in one file
// ---------------------------------------------------------------------------

/**
 * Where an agent keeps a session that lives in one file whose path follows
 * from the cwd and the session id, on the host and in the sandbox.
 */
export interface SessionFileLayout {
  /** The host directory searched by id; named in not-found errors. */
  readonly hostRoot: string;
  /** Absolute host path of the session file for a cwd. */
  readonly hostPath: (cwd: string, id: string) => string;
  /**
   * Where the session file may be on the host, found by id alone (the
   * no-sandbox precheck, where the cwd the agent used is unknown). Given the
   * names of `hostRoot`'s subdirectories, for agents that key them by cwd.
   */
  readonly hostPathsById: (
    id: string,
    hostRootSubdirs: readonly string[],
  ) => readonly string[];
  /** Sandbox path of the session file for a cwd (POSIX separators). */
  readonly sandboxPath: (cwd: string, id: string) => string;
  /**
   * For an agent whose sessions live in its own database: the sandbox command
   * that writes session `id` to `sandboxPath` before capture, run in the
   * sandbox repo.
   */
  readonly sandboxExport?: (id: string, sandboxPath: string) => string;
  /** The sandbox command that loads `sandboxPath` back after resume, run in the sandbox repo. */
  readonly sandboxImport?: (id: string, sandboxPath: string) => string;
  /** Rewrite the session's own record of its cwd when it moves. Omit to copy verbatim. */
  readonly rewrite?: (
    content: string,
    fromCwd: string,
    toCwd: string,
  ) => string;
}

interface SessionTransfer {
  readonly hostCwd: string;
  readonly sandboxCwd: string;
  readonly sessionId: string;
  readonly handle: BindMountSandboxHandle;
}

/** The error for a sandbox command that exited non-zero, with its stderr. */
const sandboxCommandError = (command: string, result: ExecResult): Error =>
  new Error(
    `\`${command}\` exited with code ${result.exitCode}: ${result.stderr.trim()}`,
  );

/** Copy a session file out of the sandbox to the host, then rewrite it. */
const captureSessionFile =
  (layout: SessionFileLayout) =>
  async (transfer: SessionTransfer): Promise<void> => {
    const { hostCwd, sandboxCwd, sessionId, handle } = transfer;
    const source = layout.sandboxPath(sandboxCwd, sessionId);
    if (layout.sandboxExport !== undefined) {
      const command = layout.sandboxExport(sessionId, source);
      const result = await handle.exec(command, { cwd: sandboxCwd });
      if (result.exitCode !== 0) {
        throw sandboxCommandError(command, result);
      }
    }
    const target = layout.hostPath(hostCwd, sessionId);
    await mkdir(dirname(target), { recursive: true });
    await handle.copyFileOut(source, target);
    if (layout.rewrite !== undefined) {
      const content = await readFile(target, "utf8");
      await writeFile(target, layout.rewrite(content, sandboxCwd, hostCwd));
    }
  };

/** Copy a session file from the host into the sandbox, rewritten on the way. */
const resumeSessionFile =
  (layout: SessionFileLayout) =>
  async (transfer: SessionTransfer): Promise<void> => {
    const { hostCwd, sandboxCwd, sessionId, handle } = transfer;
    const source = layout.hostPath(hostCwd, sessionId);
    const target = layout.sandboxPath(sandboxCwd, sessionId);
    const dir = JSON.stringify(posix.dirname(target));
    if (layout.rewrite === undefined) {
      await handle.exec(`mkdir -p ${dir}`);
      await handle.copyFileIn(source, target);
      if (layout.sandboxImport !== undefined) {
        const command = layout.sandboxImport(sessionId, target);
        const result = await handle.exec(command, { cwd: sandboxCwd });
        if (result.exitCode !== 0) {
          throw sandboxCommandError(command, result);
        }
      }
      return;
    }
    const content = await readFile(source, "utf8");
    const result = await handle.exec(
      `mkdir -p ${dir} && cat > ${JSON.stringify(target)}`,
      { stdin: layout.rewrite(content, hostCwd, sandboxCwd) },
    );
    if (result.exitCode !== 0) {
      throw new Error(`writing ${target} failed: ${result.stderr}`);
    }
  };

/**
 * The session storage operations for a {@link SessionFileLayout}: the file is
 * copied between host and sandbox as is, and rewritten only when the layout
 * says how. Binary files (an SQLite store) survive when `rewrite` is omitted.
 */
export const makeSessionFileStorage = (layout: SessionFileLayout) => ({
  hostSessionFilePath: (cwd: string, id: string): string =>
    layout.hostPath(cwd, id),
  existsOnHost: async (cwd: string, id: string): Promise<boolean> =>
    pathExists(layout.hostPath(cwd, id)),
  readHostSession: async (
    cwd: string,
    id: string,
  ): Promise<string | undefined> => {
    const path = layout.hostPath(cwd, id);
    return (await pathExists(path)) ? readFile(path, "utf8") : undefined;
  },
  findByIdOnHost: async (id: string): Promise<HostSessionLookup> => {
    let subdirs: string[] = [];
    try {
      subdirs = await readdir(layout.hostRoot);
    } catch {
      // No store yet: only paths outside hostRoot can match.
    }
    return {
      path: await firstExistingPath(layout.hostPathsById(id, subdirs)),
      searchedRoot: layout.hostRoot,
    };
  },
  captureToHost: captureSessionFile(layout),
  resumeIntoSandbox: resumeSessionFile(layout),
});
