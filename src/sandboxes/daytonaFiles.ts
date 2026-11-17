/** Daytona file transfer: the sandbox worktree folder and `copyIn`. */

import { readdir, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";

/**
 * Creates the sandbox's worktree folder and returns its path. It is a
 * subdirectory of the work dir, not the work dir itself: sync-in clones into
 * `${worktreePath}_clone` and then replaces worktreePath, which needs a
 * parent the sandbox user can write. On the default snapshot the work dir is
 * the user's home (/home/daytona), and /home is root-owned.
 */
export const createWorkspaceFolder = async (
  sandbox: DaytonaSandbox,
): Promise<string> => {
  const workDir =
    (await sandbox.getWorkDir()) ??
    (await sandbox.getUserHomeDir()) ??
    "/home/daytona";
  const worktreePath = posix.join(workDir, "workspace");
  await sandbox.fs.createFolder(worktreePath, "755");
  return worktreePath;
};

/** Every file under `dir`, recursively. */
const walkFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walkFiles(full) : [full];
    }),
  );
  return nested.flat();
};

/** Uploads a host file, or a directory's files, to `sandboxPath`. */
export const copyInToSandbox = async (
  sandbox: DaytonaSandbox,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const info = await stat(hostPath);
  if (!info.isDirectory()) {
    await sandbox.fs.uploadFile(hostPath, sandboxPath);
    return;
  }
  const files = await walkFiles(hostPath);
  if (files.length === 0) {
    return;
  }
  // One batched request, as `uploadFile` itself is `uploadFiles` of one file.
  await sandbox.fs.uploadFiles(
    files.map((file) => ({
      source: file,
      destination: join(sandboxPath, relative(hostPath, file)),
    })),
  );
};
