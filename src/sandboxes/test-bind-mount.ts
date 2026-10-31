/**
 * Filesystem-based test bind-mount sandbox provider.
 *
 * Uses a temp directory on the local filesystem as the "sandbox".
 * Intended for testing the bind-mount provider abstraction without
 * requiring Docker or Podman.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createBindMountSandboxProvider } from "../SandboxProvider.js";
import type {
  BindMountSandboxHandle,
  BindMountSandboxProvider,
} from "../SandboxProvider.js";
import { createTempSandbox } from "./test-shared.js";

/**
 * Create a filesystem-based test bind-mount sandbox provider.
 *
 * The "sandbox" is a temp directory. `exec` runs shell commands in it,
 * `copyFileIn`/`copyFileOut` copy single files between host and the temp dir,
 * and `close` removes the temp dir.
 */
export const testBindMount = (): BindMountSandboxProvider =>
  createBindMountSandboxProvider({
    name: "test-bind-mount",
    create: async (): Promise<BindMountSandboxHandle> => {
      const temp = await createTempSandbox("sandcastle-test-bm-");

      return {
        worktreePath: temp.worktreePath,
        exec: temp.exec,
        copyFileIn: async (hostPath, sandboxPath) => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },
        close: temp.close,
      };
    },
  });
