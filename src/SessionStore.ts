/**
 * SessionStore — keyed collection of agent session JSONLs.
 *
 * Provides read/write access to agent session files, with two implementations:
 * host-backed (filesystem) and sandbox-backed (via bind-mount handle
 * file-transfer primitives). The `transferSession`
 * function copies a session between stores, rewriting `cwd` fields in
 * the JSONL entries from source cwd to target cwd.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

// ---------------------------------------------------------------------------
// SessionStore interface
// ---------------------------------------------------------------------------

/** A keyed collection of agent session JSONLs associated with a cwd. */
export interface SessionStore {
  /** The working directory this store is associated with. */
  readonly cwd: string;
  /** Absolute path where a session's JSONL would be stored. */
  sessionFilePath(id: string): string;
  /** Read a session's JSONL content by ID. Throws if not found. */
  readSession(id: string): Promise<string>;
  /** Write a session's JSONL content by ID. Creates or overwrites. */
  writeSession(id: string, content: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Path encoding
// ---------------------------------------------------------------------------

/**
 * Encode a cwd into Sandcastle's `projects/<encoded>/` session layout.
 * Replaces path separators with hyphens, matching Claude Code's convention.
 */
export const encodeProjectPath = (cwd: string): string => {
  const isRoot = cwd === "/" || /^[A-Za-z]:[\\/]?$/.test(cwd);
  const normalized = isRoot ? cwd : cwd.replace(/[\\/]+$/, "");
  return normalized.replace(/^([A-Za-z]):/, "$1").replace(/[\\/]/g, "-");
};

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const findHostSessionFile = async (
  projectDir: string,
  id: string,
): Promise<string> => {
  const exactFile = `${id}.jsonl`;
  const exactPath = join(projectDir, exactFile);
  try {
    const files = await readdir(projectDir);
    if (files.includes(exactFile)) return exactPath;
    const suffix = `_${id}.jsonl`;
    const match = files.find((file) => file.endsWith(suffix));
    if (match) return join(projectDir, match);
  } catch {}
  return exactPath;
};

// ---------------------------------------------------------------------------
// Host-backed SessionStore
// ---------------------------------------------------------------------------

/**
 * Create a host-backed SessionStore that reads/writes session JSONLs on the
 * host filesystem using Sandcastle's `projects/<encoded>/` layout.
 *
 * @param cwd - The host repo directory this store is associated with.
 * @param projectsDir - Override for the projects directory (default: `~/.claude/projects`).
 */
export const hostSessionStore = (
  cwd: string,
  projectsDir?: string,
): SessionStore => {
  const baseDir =
    projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  const encoded = encodeProjectPath(cwd);
  const projectDir = join(baseDir, encoded);

  return {
    cwd,
    sessionFilePath: (id: string): string => join(projectDir, `${id}.jsonl`),
    readSession: async (id: string): Promise<string> => {
      return await readFile(await findHostSessionFile(projectDir, id), "utf-8");
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${id}.jsonl`), content);
    },
  };
};

// ---------------------------------------------------------------------------
// Sandbox-backed SessionStore
// ---------------------------------------------------------------------------

/**
 * Create a sandbox-backed SessionStore that uses a bind-mount handle's
 * `copyFileIn`/`copyFileOut` to transfer session files.
 *
 * @param cwd - The sandbox-side working directory.
 * @param handle - The bind-mount sandbox handle for file transfer.
 * @param projectsDir - The sandbox-side path to `~/.claude/projects`.
 */
export const sandboxSessionStore = (
  cwd: string,
  handle: Pick<BindMountSandboxHandle, "copyFileIn" | "copyFileOut" | "exec">,
  projectsDir: string,
): SessionStore => {
  const encoded = encodeProjectPath(cwd);
  const projectDir = join(projectsDir, encoded);

  const findSandboxSessionFile = async (id: string): Promise<string> => {
    const exactPath = join(projectDir, `${id}.jsonl`);
    const result = await handle.exec(
      `find ${shellEscape(projectDir)} -maxdepth 1 -type f \\( -name ${shellEscape(`${id}.jsonl`)} -o -name ${shellEscape(`*_${id}.jsonl`)} \\) -print -quit`,
    );
    const match = result.stdout.trim().split("\n")[0];
    return match || exactPath;
  };

  return {
    cwd,
    sessionFilePath: (id: string): string => join(projectDir, `${id}.jsonl`),
    readSession: async (id: string): Promise<string> => {
      const sandboxPath = await findSandboxSessionFile(id);
      const tmpPath = join(
        tmpdir(),
        `sandcastle-session-${id}-${Date.now()}.jsonl`,
      );
      await handle.copyFileOut(sandboxPath, tmpPath);
      try {
        return await readFile(tmpPath, "utf-8");
      } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      const sandboxPath = join(projectDir, `${id}.jsonl`);
      const tmpPath = join(
        tmpdir(),
        `sandcastle-session-${id}-${Date.now()}.jsonl`,
      );
      await writeFile(tmpPath, content);
      try {
        // Ensure the sandbox-side project directory exists — `docker cp` /
        // `podman cp` require the destination's parent directory to exist.
        await handle.exec(`mkdir -p ${JSON.stringify(projectDir)}`);
        await handle.copyFileIn(tmpPath, sandboxPath);
      } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    },
  };
};

// ---------------------------------------------------------------------------
// transferSession
// ---------------------------------------------------------------------------

/**
 * Transfer a session from one store to another, rewriting `cwd` fields in
 * the JSONL entries from the source store's cwd to the target store's cwd.
 */
export const transferSession = async (
  from: SessionStore,
  to: SessionStore,
  id: string,
): Promise<void> => {
  const content = await from.readSession(id);

  if (content === "") {
    await to.writeSession(id, "");
    return;
  }

  const rewritten = content
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.cwd === "string" && entry.cwd === from.cwd) {
        entry.cwd = to.cwd;
      }
      return JSON.stringify(entry);
    })
    .join("\n");

  await to.writeSession(id, rewritten);
};
