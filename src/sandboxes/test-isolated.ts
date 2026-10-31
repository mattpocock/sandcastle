/**
 * Filesystem-based test isolated sandbox provider.
 *
 * Uses a temp directory on the local filesystem as the "sandbox".
 * Intended for testing the isolated provider abstraction without
 * requiring a real remote environment.
 */

import { copyFile, cp, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { createTempSandbox } from "./test-shared.js";

/**
 * Create a filesystem-based test isolated sandbox provider.
 *
 * The "sandbox" is a temp directory. `exec` runs shell commands in it,
 * `copyIn`/`copyFileOut` copy files between host and the temp dir,
 * and `close` removes the temp dir.
 */
export const testIsolated = (): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "test-isolated",
    create: async (): Promise<IsolatedSandboxHandle> => {
      const temp = await createTempSandbox("sandcastle-test-");

      return {
        worktreePath: temp.worktreePath,
        exec: temp.exec,
        copyIn: async (hostPath, sandboxPath) => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            await cp(hostPath, sandboxPath, { recursive: true });
          } else {
            await mkdir(dirname(sandboxPath), { recursive: true });
            await copyFile(hostPath, sandboxPath);
          }
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },
        close: temp.close,
      };
    },
  });
