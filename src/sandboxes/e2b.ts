/**
 * E2B isolated sandbox provider — wraps the `e2b` SDK into a SandboxProvider.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Sandbox, SandboxOpts } from "e2b";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { makeExec } from "./e2bExec.js";
import { makeCopyIn, runToEnd } from "./e2bFiles.js";

/**
 * Options for the E2B sandbox provider.
 *
 * All `Sandbox.create()` options from the `e2b` SDK pass through (`template`,
 * `timeoutMs`, `apiKey`, `metadata`, `network`, ...), except `envs` and
 * `lifecycle`, which the provider controls.
 *
 * `apiKey` falls back to the `E2B_API_KEY` environment variable. `timeoutMs`
 * defaults to 30 minutes; the sandbox is killed when it expires, so it must
 * cover setup, the agent run and syncing changes back.
 */
export interface E2BOptions extends Omit<SandboxOpts, "envs" | "lifecycle"> {
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum characters of streamed `exec` output kept per stream for
   * `ExecResult` when `onLine` is supplied (default: 64KiB). `onLine` still
   * gets every line.
   */
  readonly maxOutputTailChars?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Create `$HOME/workspace` and return its path. On failure, kill the sandbox:
 * no handle exists yet, so nothing else could reach it before its timeout.
 */
const prepareWorktree = async (sandbox: Sandbox): Promise<string> => {
  const mkdirCommand =
    'mkdir -p "$HOME/workspace" && cd "$HOME/workspace" && pwd';
  try {
    const out = await runToEnd(sandbox, mkdirCommand);
    return out.trim();
  } catch (error) {
    await sandbox.kill().catch(() => undefined);
    throw error;
  }
};

/**
 * Create an E2B isolated sandbox provider.
 *
 * Each sandbox is ephemeral: `create()` starts a new E2B sandbox and
 * `close()` kills it. Pausing is never enabled. Requires `e2b` to be
 * installed as a peer dependency, and `E2B_API_KEY` in the host environment
 * (or the `apiKey` option). E2B's default template has no agent CLI: use a
 * template that ships one (such as `"claude"` or `"codex"`), or install it in
 * an `onSandboxReady` hook.
 */
export const e2b = (options?: E2BOptions): IsolatedSandboxProvider => {
  const {
    env,
    maxOutputTailChars: maxTail = MAX_TAIL_CHARS,
    apiKey,
    ...sdkOptions
  } = options ?? {};
  return createIsolatedSandboxProvider({
    name: "e2b",
    env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      // Dynamic import so the peer dependency is only loaded at runtime
      const { Sandbox: E2BSandbox, CommandExitError: ExitError } = await import(
        "e2b"
      );
      const sandbox = await E2BSandbox.create({
        ...sdkOptions,
        // An empty key counts as unset, so the SDK reads E2B_API_KEY
        ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
        timeoutMs: sdkOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        envs: createOptions.env,
        lifecycle: { onTimeout: "kill", autoResume: false },
      });
      const worktreePath = await prepareWorktree(sandbox);

      return {
        worktreePath,
        sandboxId: sandbox.sandboxId,
        exec: makeExec({ ExitError, sandbox, worktreePath, maxTail }),
        copyIn: makeCopyIn(sandbox),
        copyFileOut: async (sandboxPath, hostPath) => {
          const content = await sandbox.files.read(sandboxPath, {
            format: "bytes",
          });
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, content);
        },
        close: async () => {
          await sandbox.kill();
        },
      };
    },
  });
};
