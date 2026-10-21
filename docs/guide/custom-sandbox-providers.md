# Custom sandbox providers

Sandcastle ships with built-in providers for Docker, Podman, and Vercel, but you can create your own. A sandbox provider tells Sandcastle how to execute commands in an isolated environment. There are two kinds:

- **Bind-mount** — the sandbox can mount a host directory. Sandcastle creates a worktree on the host and the provider mounts it in. No file sync needed. Use this for Docker, Podman, or any local container runtime.
- **Isolated** — the sandbox has its own filesystem (e.g. a cloud VM). The provider handles syncing code in and out via `copyIn` and `copyFileOut`. Use this when the sandbox cannot access the host filesystem.

## The sandbox handle contract

Both provider types return a **sandbox handle** from their `create()` function. The handle exposes:

| Method         | Required   | Description                                                                  |
| -------------- | ---------- | ---------------------------------------------------------------------------- |
| `exec`         | Both       | Run a command, optionally streaming stdout line-by-line via `options.onLine` |
| `close`        | Both       | Tear down the sandbox                                                        |
| `copyFileIn`   | Bind-mount | Copy a single file from the host into the sandbox                            |
| `copyFileOut`  | Both       | Copy a single file from the sandbox to the host                              |
| `copyIn`       | Isolated   | Copy a file or directory from the host into the sandbox                      |
| `worktreePath` | Both       | Absolute path to the repo directory inside the sandbox                       |

## `ExecResult`

Every `exec` call returns an `ExecResult`:

```typescript
interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
```

## Bind-mount provider example

A minimal bind-mount provider that shells out to local processes (no container):

```typescript
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "@ai-hero/sandcastle";
import { execFile, spawn } from "node:child_process";
import { copyFile as fsCopyFile, mkdir as fsMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const localProcess = () =>
  createBindMountSandboxProvider({
    name: "local-process",
    create: async (
      options: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const worktreePath = options.worktreePath;

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line); // forward each line to Sandcastle
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyFileIn: async (hostPath: string, sandboxPath: string) => {
          await fsMkdir(dirname(sandboxPath), { recursive: true });
          await fsCopyFile(hostPath, sandboxPath);
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await fsMkdir(dirname(hostPath), { recursive: true });
          await fsCopyFile(sandboxPath, hostPath);
        },

        close: async () => {
          // nothing to tear down for a local process
        },
      };
    },
  });
```

## Isolated provider example

A minimal isolated provider using a temp directory:

```typescript
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type ExecResult,
} from "@ai-hero/sandcastle";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const tempDir = () =>
  createIsolatedSandboxProvider({
    name: "temp-dir",
    create: async (): Promise<IsolatedSandboxHandle> => {
      const root = await mkdtemp(join(tmpdir(), "sandbox-"));
      const worktreePath = join(root, "workspace");
      await mkdir(worktreePath, { recursive: true });

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyIn: async (hostPath: string, sandboxPath: string) => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            await cp(hostPath, sandboxPath, { recursive: true });
          } else {
            await mkdir(dirname(sandboxPath), { recursive: true });
            await copyFile(hostPath, sandboxPath);
          }
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },

        close: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
```

## Branch strategies

A branch strategy controls where the agent's commits land. Configure it when constructing the provider:

| Strategy        | Behavior                                                                 | Bind-mount | Isolated  |
| --------------- | ------------------------------------------------------------------------ | ---------- | --------- |
| `head`          | Agent writes directly to the host working directory. No worktree created | Default    | N/A       |
| `merge-to-head` | Sandcastle creates a temp branch, merges back to HEAD when done          | Supported  | Default   |
| `branch`        | Commits land on an explicit named branch you provide                     | Supported  | Supported |

**When to use each:**

- **`head`** — fast iteration during development. No branch indirection, no merge step. Only works with bind-mount providers since the agent needs direct host filesystem access.
- **`merge-to-head`** — safe default for automation. The agent works on a throwaway branch; if something goes wrong, HEAD is untouched. Use this for CI or unattended runs.
- **`branch`** — when you want commits on a specific branch (e.g. for a PR). Pass `{ type: "branch", branch: "agent/fix-42" }`.

Branch strategy is now configured on `run()`, not on the provider:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// head — direct write, bind-mount only (default for bind-mount providers)
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "…",
});
// merge-to-head — temp branch, merge back (default for isolated providers)
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: tempDir(),
  prompt: "…",
});
// branch — explicit named branch
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  prompt: "…",
});
```

## Passing to `run()`

Pass your custom provider via the `sandbox` option — it works the same as the built-in `docker()` provider:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: localProcess(), // your custom provider
  prompt: "Fix issue #42 in this repo.",
});
```

## Reference implementations

For real-world examples, see:

- [`src/sandboxes/docker.ts`](../../src/sandboxes/docker.ts) — bind-mount provider using Docker containers (with SELinux label support)
- [`src/sandboxes/vercel.ts`](../../src/sandboxes/vercel.ts) — isolated provider using Vercel Firecracker microVMs via `@vercel/sandbox`
- [`src/sandboxes/podman.ts`](../../src/sandboxes/podman.ts) — bind-mount provider using Podman containers (with SELinux label support)
- [`src/sandboxes/test-isolated.ts`](../../src/sandboxes/test-isolated.ts) — isolated provider using temp directories (used in tests)
