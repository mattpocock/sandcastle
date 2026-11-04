import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProvider } from "./SandboxProvider.js";
import { createSandboxProvider } from "./SandboxProvider.js";
import type {
  FakeProviderSandbox,
  FakeRoot,
  FakeSandboxNative,
} from "./fakeSandboxInstance.js";
import {
  createFakeSandbox,
  getFakeSandbox,
  spawnInFakeSandbox,
} from "./fakeSandboxInstance.js";

/** Options for `fakeSandbox()`. */
export interface FakeSandboxOptions {
  /**
   * Where sandbox directories are made. Default a shared `sandcastle-fake`
   * directory under the OS temp dir. Another `fakeSandbox()` (or process)
   * finds a sandbox by id only with the same `rootDir`. Never deleted itself.
   */
  readonly rootDir?: string;
}

/** The fake provider, plus what a test needs to inspect and clean up. */
export interface FakeSandboxProvider
  extends SandboxProvider<FakeSandboxNative, true>,
    AsyncDisposable {
  /**
   * The host directory backing a sandbox, `<rootDir>/<sandboxId>`, whether or
   * not it still exists. It holds `work/` (the working directory), `home/`
   * (`HOME`) and `tmp/` (`TMPDIR`).
   */
  readonly pathOf: (sandboxId: string) => string;
  /** Close every sandbox this provider made that's still open. For `afterEach`. */
  readonly closeAll: () => Promise<void>;
}

/**
 * A sandbox provider for tests: real temp directories and real `sh` child
 * processes, no cloud account. Each command sees the host's `PATH`, the
 * sandbox's env, its own env, and a private `HOME` and `TMPDIR` inside the
 * sandbox, and nothing else from your process. File paths outside the
 * sandbox's directory are refused. At its kill time (creation plus
 * `timeLimitMinutes`, fractions allowed) a sandbox's processes are killed and
 * its directory removed. Its sandboxes are detachable. `sudo` is accepted and
 * ignored: everything runs as you. POSIX only.
 */
export const fakeSandbox = (
  options: FakeSandboxOptions = {},
): FakeSandboxProvider => {
  const root: FakeRoot = {
    rootDir: options.rootDir ?? path.join(tmpdir(), "sandcastle-fake"),
  };
  const open = new Set<FakeProviderSandbox>();
  const provider = createSandboxProvider({
    name: "fake",
    create: async (createOptions) => {
      const sandbox = await createFakeSandbox(root, createOptions, (closed) => {
        open.delete(closed);
      });
      open.add(sandbox);
      return sandbox;
    },
    detach: {
      spawnDetached: (sandbox, spawnOptions) =>
        spawnInFakeSandbox(sandbox, spawnOptions),
      get: (sandboxId) => getFakeSandbox(root, sandboxId),
    },
  });
  const closeAll = async () => {
    await Promise.all([...open].map((sandbox) => sandbox.close()));
  };
  return Object.assign(provider, {
    pathOf: (sandboxId: string) => path.join(root.rootDir, sandboxId),
    closeAll,
    [Symbol.asyncDispose]: closeAll,
  });
};
