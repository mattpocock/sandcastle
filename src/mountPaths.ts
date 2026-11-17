/**
 * Host and sandbox path resolution for mounts: tilde expansion, then
 * resolving relative paths against the host cwd or the sandbox repo dir.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { SANDBOX_REPO_DIR } from "./sandboxService.js";

/**
 * Expand tilde (`~`) to the given home directory (or `os.homedir()` if omitted).
 * Handles both `~/path` (POSIX) and `~\path` (Windows).
 */
export const expandTilde = (p: string, homeDirPath?: string): string => {
  const home = homeDirPath ?? homedir();
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return `${home}/${p.slice(2)}`;
  }
  return p;
};

/**
 * Resolve a host path: expand tilde, then resolve relative paths from `process.cwd()`.
 */
export const resolveHostPath = (hostPath: string): string => {
  const expanded = expandTilde(hostPath);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
};

/**
 * Resolve a sandbox path: expands tilde using `sandboxHomedir`, then resolves
 * relative paths from `SANDBOX_REPO_DIR`.
 *
 * Throws if `sandboxPath` starts with `~` but `sandboxHomedir` is `undefined`.
 */
export const resolveSandboxPath = (
  sandboxPath: string,
  sandboxHomedir?: string,
): string => {
  const hasTilde =
    sandboxPath === "~" ||
    sandboxPath.startsWith("~/") ||
    sandboxPath.startsWith("~\\");
  if (hasTilde && sandboxHomedir === undefined) {
    throw new Error(
      `sandboxPath "${sandboxPath}" contains a tilde but the provider has no sandboxHomedir set`,
    );
  }
  const expanded = hasTilde
    ? expandTilde(sandboxPath, sandboxHomedir)
    : sandboxPath;
  return isAbsolute(expanded) ? expanded : resolve(SANDBOX_REPO_DIR, expanded);
};
