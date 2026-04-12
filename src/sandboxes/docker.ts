/**
 * Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider.
 *
 * Usage:
 *   import { docker } from "sandcastle/sandboxes/docker";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: docker() });
 */

import { execFile, execFileSync, spawn } from "node:child_process";
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
  type BindMountBranchStrategy,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "../SandboxProvider.js";

export interface DockerOptions {
  /** Docker image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /** Branch strategy for this provider. Defaults to { type: "head" }. */
  readonly branchStrategy?: BindMountBranchStrategy;
}

/**
 * Create a Docker sandbox provider.
 *
 * The returned provider creates Docker containers with bind-mounts
 * for the worktree and git directories.
 */
export const docker = (options?: DockerOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;

  return createBindMountSandboxProvider({
    name: "docker",
    branchStrategy: options?.branchStrategy,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const workspacePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      // Build volume mount strings
      const volumeMounts = createOptions.mounts.map((m) => {
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

        exec: (command: string, opts?: { cwd?: string }): Promise<ExecResult> =>
          execViaStdin(containerName, command, opts),

        execStreaming: (
          command: string,
          onLine: (line: string) => void,
          opts?: { cwd?: string },
        ): Promise<ExecResult> =>
          execViaStdin(containerName, command, opts, onLine),

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
  opts?: { cwd?: string },
  onLine?: (line: string) => void,
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
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
      onLine?.(line);
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

    proc.stdin!.end(command);
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
