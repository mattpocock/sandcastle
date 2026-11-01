# Sandbox providers

> **Sandbox provider**: A pluggable implementation that creates and manages a **sandbox**, injected into `run()` via the `sandbox` option.

> **Bind-mount sandbox provider**: A **sandbox provider** where the **host** filesystem is mounted directly into the environment.

> **Native sandbox provider**: A **bind-mount sandbox provider** that contains the **agent** with the **host** OS's own process sandbox (Bubblewrap, Seatbelt) instead of a container, using the **host**'s toolchain.

> **Isolated sandbox provider**: A **sandbox provider** where the environment has its own filesystem, requiring sync to move code in and commits out.

> **No-sandbox provider**: A **sandbox provider** where no container is created -- the **agent** runs directly on the **host**.

> **Build-image**: A provider-namespaced CLI command that rebuilds the image (e.g. `sandcastle docker build-image`).

> **Remove-image**: A provider-namespaced CLI command that removes the image (e.g. `sandcastle docker remove-image`).

Sandcastle uses a `SandboxProvider` to create isolated environments. The `sandbox` option on `run()`, `interactive()`, and `createSandbox()` accepts any provider, including `noSandbox()`: opt in to running the agent directly on the host when isolation is undesired. Built-in providers:

| Provider   | Import path                                | Type                | Accepted by                                 |
| ---------- | ------------------------------------------ | ------------------- | ------------------------------------------- |
| Bubblewrap | `@ai-hero/sandcastle/sandboxes/bwrap`      | Native (bind-mount) | `run()`, `createSandbox()`                  |
| Seatbelt   | `@ai-hero/sandcastle/sandboxes/seatbelt`   | Native (bind-mount) | `run()`, `createSandbox()`                  |
| Docker     | `@ai-hero/sandcastle/sandboxes/docker`     | Bind-mount          | `run()`, `createSandbox()`, `interactive()` |
| Podman     | `@ai-hero/sandcastle/sandboxes/podman`     | Bind-mount          | `run()`, `createSandbox()`, `interactive()` |
| Vercel     | `@ai-hero/sandcastle/sandboxes/vercel`     | Isolated            | `run()`, `createSandbox()`, `interactive()` |
| No-sandbox | `@ai-hero/sandcastle/sandboxes/no-sandbox` | None                | `run()`, `createSandbox()`, `interactive()` |

Worktree methods (`wt.run()`, `wt.interactive()`, `wt.createSandbox()`) accept the same providers as their top-level counterparts. `wt.interactive()` defaults to `noSandbox()` when no sandbox is specified.

```typescript
import { run, interactive, claudeCode } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import { seatbelt } from "@ai-hero/sandcastle/sandboxes/seatbelt";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

// Pick the native sandbox for this OS, so one main.ts works on macOS and Linux:
const sandbox = process.platform === "darwin" ? seatbelt() : bwrap();

// Native, Docker, Podman, and Vercel providers are interchangeable in run() and createSandbox():
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox,
  prompt: "...",
});

// No-sandbox runs the agent directly on the host, accepted by run(),
// createSandbox(), and interactive(). Skips isolation entirely:
await interactive({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: noSandbox(),
  prompt: "...", // optional: omit to launch the TUI with no initial prompt
  cwd: "/path/to/other-repo", // optional: defaults to process.cwd()
});
```

You can also [create your own provider](#custom-sandbox-providers) using `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`.

## Native sandboxes: `bwrap()` and `seatbelt()`

A native sandbox contains the agent with your OS's own process sandbox instead of a container: Bubblewrap on Linux and WSL2, Seatbelt on macOS. There's no image to build and no daemon to run. Each `exec` is a fresh sandboxed process that runs your host's own tools, read-only.

- **Files.** The agent can write only the repo (or its worktree), the git dirs Sandcastle mounts, a private temp dir and a private home. Your home directory, SSH keys, agent logins and other repos are hidden. The repo appears at its real host path, as it does under `noSandbox()`.
- **Toolchain.** Every directory on your host `PATH` is readable, plus the install root of each executable symlinked from one, so a `claude` in `~/.local/bin` or an nvm-installed `codex` just works. The install root is the executable's package when it's installed under a `node_modules` dir, and otherwise only the executable's own directory, so an `npm link`ed checkout isn't exposed. A `PATH` entry equal to your home directory or an ancestor of it, and an install root holding a `.git`, are never mounted. Add other paths with `mounts`.
- **Logins.** Each sandbox gets a fresh private home, removed on close, so the agent can't use the logins stored in your home directory: `~/.claude`, `~/.codex`, `~/.config/gh`. `seatbelt()` doesn't promise to keep the agent away from your macOS Keychain, so don't rely on it for that. Put the agent's login in `.sandcastle/.env` (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and so on), and a `GH_TOKEN` there for `gh`. Your git identity is still copied in, so commits carry your name.
- **Env.** The agent sees only the env vars Sandcastle passes in, plus `PATH`, `HOME` and `TMPDIR`.
- **Processes.** The agent can't signal your processes, and every process it started is killed when the sandbox closes. Under `seatbelt()`, a process that leaves its process group (by calling `setsid` or `setpgid`) is the exception: see [Containment](#containment).
- **Network.** Open, including your host's localhost.
- **No root.** `exec` and hooks with `sudo: true` reject, pointing to `docker()`. There's no image to install system packages into, so install them on your host.
- **No `interactive()`.** `interactive()` with a native provider throws `NativeInteractiveNotSupportedError`. Use `run()`, or pass `docker()` or `noSandbox()` to `interactive()`.

Both take the same small set of options:

```typescript
bwrap({
  env: { MY_VAR: "value" }, // merged at launch, like docker()'s env
  mounts: [
    // Each path appears at its own host path inside the sandbox, so
    // sandboxPath must equal hostPath. readonly defaults to false.
    { hostPath: "/opt/my-tool-cache", sandboxPath: "/opt/my-tool-cache" },
    {
      hostPath: "/home/me/shared-config",
      sandboxPath: "/home/me/shared-config",
      readonly: true,
    },
  ],
  maxOutputTailChars: 65_536, // same as docker()'s
});
```

Constructing a native provider checks, once per process, that your machine can run it. If it can't, it throws `NativeSandboxUnavailableError`, with a `fixCommand` when there's one to run. It throws before any worktree exists, and it never falls back to running the agent unsandboxed.

```typescript
import { NativeSandboxUnavailableError } from "@ai-hero/sandcastle";

try {
  bwrap();
} catch (error) {
  if (error instanceof NativeSandboxUnavailableError) {
    console.error(error.message); // why, in plain words
    console.error(error.fixCommand); // e.g. "sudo apt install bubblewrap", or undefined
  }
}
```

**`bwrap()` on Linux.** It needs `bwrap` on `PATH`; the error gives your distro's install command if it's missing. Ubuntu 24.04 and later block the unprivileged user namespaces Bubblewrap needs with AppArmor. The error says so, and its `fixCommand` gives `bwrap` an AppArmor profile that allows them:

```bash
printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap %s flags=(unconfined) {\n  userns,\n}\n' "$(command -v bwrap)" \
  | sudo tee /etc/apparmor.d/bwrap >/dev/null && sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Or, more bluntly, allow user namespaces for every program: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

**`bwrap()` on Windows.** Run Sandcastle inside [WSL2](https://learn.microsoft.com/windows/wsl/install) and use `bwrap()`, with your repo on the Linux filesystem (ext4, for example `~/code/my-repo`), not under `/mnt/c`. Inside the sandbox, `/mnt`, `/run/WSL` and `WSL_INTEROP` are hidden, so the agent can't run a Windows `.exe`.

**`seatbelt()` on macOS.** It needs macOS 14 or later and runs the system `/usr/bin/sandbox-exec`, so there's nothing to install. macOS refuses to nest Seatbelt sandboxes, so `seatbelt()` can't start inside another one; the error says so.

**Agents' own sandboxes.** The native sandbox is the containment layer, and Sandcastle already runs agents with their permission prompts skipped, so turn off the agent's own sandboxing. An agent can't apply its own Seatbelt sandbox inside `seatbelt()`, because macOS refuses to nest them. Inside `bwrap()`, whether an agent's own Bubblewrap sandbox can start depends on your kernel.

## Containment

What a sandbox protects you from depends on the provider. Native sandboxes are built for **accidents and prompt injection**: an agent that runs the wrong command, or follows instructions planted in an issue or a web page, can't read your credentials, write outside the repo, or touch your other processes.

They don't protect against:

- **Kernel escapes.** A native sandbox is a shared-kernel process sandbox. On Linux, `bwrap()` is about as strong as a runc container (Docker on Linux). On macOS, `seatbelt()` is weaker than Docker Desktop, which runs containers in a VM.
- **Services on your host's localhost.** The network is open, and the sandbox can reach anything listening on `127.0.0.1`, such as a dev server or a local database.
- **Process listing on macOS.** Seatbelt has no PID namespace. The agent can't signal your processes, and `ps`, `pgrep` and the process-list sysctl are blocked, but your processes aren't hidden the way they are in `bwrap()`'s own PID namespace. Paths outside the sandbox are visible as metadata: the agent can check that a path exists and read its size and timestamps, but not its contents.
- **Detached processes on macOS.** `seatbelt()` kills each `exec`'s process group. A process that leaves that group, by calling `setsid` or `setpgid`, survives `close()` and your Node process being killed. It is still under the Seatbelt profile, so it can still write the worktree and reach the network, until it exits or you kill it.

For an image-based sandbox, or a VM boundary on macOS and Windows, use `docker()` or `podman()`. For stronger isolation than a shared kernel, use a remote provider such as `vercel()`, which runs the agent in its own Firecracker microVM.

## Build-image and remove-image

An image-based provider (`docker()`, `podman()`) runs the agent in an image built from the config directory. Rebuild it after you change the `Dockerfile` or `Containerfile`, and remove it when you no longer need it: see [`sandcastle docker build-image`](./cli.md#sandcastle-docker-build-image) and the commands after it. Native providers have no image.

## Custom sandbox providers

Sandcastle ships with built-in providers for Docker, Podman, and Vercel, but you can create your own. A sandbox provider tells Sandcastle how to execute commands in an isolated environment. There are two kinds:

- **Bind-mount** — the sandbox can mount a host directory. Sandcastle creates a worktree on the host and the provider mounts it in. No file sync needed. Use this for Docker, Podman, or any local container runtime.
- **Isolated** — the sandbox has its own filesystem (e.g. a cloud VM). The provider handles syncing code in and out via `copyIn` and `copyFileOut`. Use this when the sandbox cannot access the host filesystem.

### The sandbox handle contract

Both provider types return a **sandbox handle** from their `create()` function. The handle exposes:

| Method           | Required             | Description                                                                       |
| ---------------- | -------------------- | --------------------------------------------------------------------------------- |
| `exec`           | Both                 | Run a command, optionally streaming stdout line-by-line via `options.onLine`      |
| `close`          | Both                 | Tear down the sandbox                                                             |
| `copyFileIn`     | Bind-mount           | Copy a single file from the host into the sandbox                                 |
| `copyFileOut`    | Both                 | Copy a single file from the sandbox to the host                                   |
| `copyIn`         | Isolated             | Copy a file or directory from the host into the sandbox                           |
| `worktreePath`   | Both                 | Absolute path to the repo directory inside the sandbox                            |
| `sandboxHomedir` | Bind-mount, optional | The agent's home as commands inside the sandbox see it. Defaults to `/home/agent` |
| `sandboxTmpdir`  | Bind-mount, optional | A writable temp dir as commands inside the sandbox see it. Defaults to `/tmp`     |

### `ExecResult`

Every `exec` call returns an `ExecResult`:

```typescript
interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
```

### Bind-mount provider example

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

### Isolated provider example

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

### Passing to `run()`

Pass your custom provider via the `sandbox` option — it works the same as the built-in `docker()` provider:

```typescript
import { run, claudeCode } from "@ai-hero/sandcastle";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: localProcess(), // your custom provider
  prompt: "Fix issue #42 in this repo.",
});
```

### Reference implementations

For real-world examples, see:

- [`src/sandboxes/docker.ts`](../../src/sandboxes/docker.ts) — bind-mount provider using Docker containers (with SELinux label support)
- [`src/sandboxes/vercel.ts`](../../src/sandboxes/vercel.ts) — isolated provider using Vercel Firecracker microVMs via `@vercel/sandbox`
- [`src/sandboxes/podman.ts`](../../src/sandboxes/podman.ts) — bind-mount provider using Podman containers (with SELinux label support)
- [`src/sandboxes/test-isolated.ts`](../../src/sandboxes/test-isolated.ts) — isolated provider using temp directories (used in tests)

## Related terms

- [Core concepts](./core-concepts.md): sandbox, host and agent
- [Branch strategies](./branch-strategies.md): how a worktree is mounted into a bind-mount sandbox, or synced with an isolated one
- [Hooks](./hooks.md): sandbox hooks, and `sudo: true` on each provider
- [Init](./init.md): choosing a provider during init, and the custom Dockerfile
- [CLI commands](./cli.md): build-image and remove-image
- [`createSandbox()`](./run.md#createsandbox--reusable-sandbox): one sandbox for several runs
