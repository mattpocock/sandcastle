/**
 * Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider.
 *
 * Usage:
 *   import { docker } from "sandcastle/sandboxes/docker";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: docker() });
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "../DockerLifecycle.js";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "../SandboxProvider.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { MountConfig } from "../MountConfig.js";

export interface DockerOptions {
  /** Docker image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
}

/**
 * Create a Docker sandbox provider.
 *
 * The returned provider creates Docker containers with bind-mounts
 * for the worktree and git directories.
 */
export const docker = (options?: DockerOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const userMounts = options?.mounts ? resolveUserMounts(options.mounts) : [];

  return createBindMountSandboxProvider({
    name: "docker",
    env: options?.env,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const workspacePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      // Build volume mount strings (internal mounts + user-provided mounts)
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) => {
        const base = `${m.hostPath}:${m.sandboxPath}`;
        return m.readonly ? `${base}:ro` : base;
      });

      // Resolve image name
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      const hostUid = process.getuid?.() ?? 1000;
      const hostGid = process.getgid?.() ?? 1000;

      // Start container
      await Effect.runPromise(
        startContainer(
          containerName,
          imageName,
          {
            ...createOptions.env,
            HOME: "/home/agent",
          },
          {
            volumeMounts,
            workdir: workspacePath,
            user: `${hostUid}:${hostGid}`,
          },
        ).pipe(
          Effect.andThen(
            chownInContainer(
              containerName,
              `${hostUid}:${hostGid}`,
              "/home/agent",
            ),
          ),
        ),
      );

      // Set up signal handlers for cleanup
      const onExit = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const onSignal = () => {
        onExit();
        process.exit(1);
      };
      process.on("exit", onExit);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      const handle: BindMountSandboxHandle = {
        workspacePath,

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
          },
        ): Promise<ExecResult> =>
          execViaStdin(containerName, command, opts),

        close: async (): Promise<void> => {
          process.removeListener("exit", onExit);
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
          await Effect.runPromise(removeContainer(containerName));
        },
      };

      return handle;
    },
  });
};

const execViaStdin = (
  containerName: string,
  command: string,
  opts?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean },
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
    const args = ["exec", "-i"];
    if (opts?.cwd) args.push("-w", opts.cwd);
    args.push(containerName, "sh");

    const proc = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      opts?.onLine?.(line);
    });

    proc.stdout!.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on("error", (error) => {
      reject(new Error(`docker exec failed: ${error.message}`));
    });

    proc.on("close", (code) => {
      rl.close();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code ?? 0,
      });
    });

    proc.stdin!.end(effectiveCommand);
  });

/**
 * Derive the default Docker image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for Docker image tag rules.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/\/+$/, "").split("/").pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
};

const expandTilde = (p: string): string => {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
};

const resolveUserMounts = (
  mounts: readonly MountConfig[],
): Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }> =>
  mounts.map((m) => {
    const resolvedHostPath = expandTilde(m.hostPath);

    if (!existsSync(resolvedHostPath)) {
      throw new Error(
        `Mount hostPath does not exist: ${m.hostPath}` +
          (m.hostPath !== resolvedHostPath
            ? ` (resolved to ${resolvedHostPath})`
            : ""),
      );
    }

    return {
      hostPath: resolvedHostPath,
      sandboxPath: m.sandboxPath,
      ...(m.readonly ? { readonly: true } : {}),
    };
  });
