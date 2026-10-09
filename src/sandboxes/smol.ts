/** Run Sandcastle's isolated worktree in a local or cloud Smol microVM. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import type { ResourceSpec } from "smolmachines";

const execFileAsync = promisify(execFile);
const WORKTREE = "/var/tmp/sandcastle-workspace";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface SmolOptions {
  /** Default: `local`. Cloud uses `SMOL_CLOUD_TOKEN` unless `apiKey` is set. */
  readonly target?: "local" | "cloud";
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Default: `node:22`, which includes Node.js, Git and a POSIX shell. */
  readonly image?: string;
  /** Defaults to 2 vCPUs, 2 GiB of memory, and outbound network access. */
  readonly resources?: ResourceSpec;
  /** Cloud VM lifetime in seconds, even if the host exits unexpectedly; default: 24 hours. */
  readonly ttlSeconds?: number;
  /** Variables passed into the machine and every command, merged with Sandcastle's agent environment. */
  readonly env?: Record<string, string>;
  /** Maximum retained streamed output per channel; live lines are delivered in full. */
  readonly maxOutputTailChars?: number;
}

/** Create a disposable Smol VM for each Sandcastle worktree. */
export const smol = (options: SmolOptions = {}): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "smol",
    env: options.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const { Machine } = await import("smolmachines");
      const machine = await Machine.create(
        {
          image: options.image ?? "node:22",
          resources: {
            cpus: 2,
            memoryMb: 2048,
            network: true,
            ...options.resources,
          },
          env: createOptions.env,
          ...(options.target === "cloud"
            ? { ttlSeconds: options.ttlSeconds ?? 24 * 60 * 60 }
            : {}),
        },
        {
          target: options.target ?? "local",
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        },
      );

      try {
        const ready = await machine.exec(["mkdir", "-p", WORKTREE]);
        if (ready.exitCode !== 0) throw new Error(ready.stderr);
      } catch (error) {
        await machine.delete().catch(() => {});
        throw error;
      }

      let closed = false;
      const maxOutputTailChars = options.maxOutputTailChars ?? MAX_TAIL_CHARS;
      const exec: IsolatedSandboxHandle["exec"] = async (command, opts) => {
        const inputPath =
          opts?.stdin !== undefined
            ? `/tmp/sandcastle-stdin-${randomUUID()}`
            : undefined;
        if (inputPath) await machine.writeFile(inputPath, opts!.stdin!);
        const script = inputPath
          ? `sh -c ${quote(command)} < ${quote(inputPath)}`
          : command;
        const output: string[] = [];
        const errors: string[] = [];
        const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
        const stderrTail = new BoundedTail(maxOutputTailChars);
        let incomplete = "";
        let exitCode: number | undefined;

        try {
          for await (const event of machine.execStream(["sh", "-c", script], {
            workdir: opts?.cwd ?? WORKTREE,
            env: createOptions.env,
            ...(opts?.sudo ? { user: "root" } : {}),
          })) {
            if (event.kind === "stdout") {
              if (!opts?.onLine) {
                output.push(event.data);
                continue;
              }
              const lines = (incomplete + event.data).split("\n");
              incomplete = lines.pop() ?? "";
              for (const line of lines) {
                opts.onLine(line);
                stdoutTail.push(line);
              }
            } else if (event.kind === "stderr") {
              if (opts?.onLine) stderrTail.push(event.data);
              else errors.push(event.data);
            } else if (event.kind === "error") {
              throw new Error(event.message);
            } else {
              exitCode = event.exitCode;
            }
          }
          if (exitCode === undefined)
            throw new Error("Smol command stream ended without an exit status");
          if (incomplete) {
            opts?.onLine?.(incomplete);
            stdoutTail.push(incomplete);
          }
          return {
            stdout: opts?.onLine ? stdoutTail.toString() : output.join(""),
            stderr: opts?.onLine ? stderrTail.toString() : errors.join(""),
            exitCode,
          } satisfies ExecResult;
        } finally {
          if (inputPath)
            await machine.exec(["rm", "-f", inputPath]).catch(() => {});
        }
      };

      const execOk = async (command: string): Promise<void> => {
        const result = await exec(command);
        if (result.exitCode !== 0)
          throw new Error(
            `Smol sandbox command failed (${result.exitCode}): ${result.stderr}`,
          );
      };

      return {
        worktreePath: WORKTREE,
        exec,
        copyIn: async (hostPath, sandboxPath) => {
          const source = await stat(hostPath);
          if (!source.isDirectory()) {
            await execOk(`mkdir -p ${quote(dirname(sandboxPath))}`);
            await machine.writeFile(
              sandboxPath,
              await readFile(hostPath),
              source.mode & 0o777,
            );
            return;
          }

          const directory = await mkdtemp(join(tmpdir(), "sandcastle-smol-"));
          const archive = join(directory, "files.tar.gz");
          const guestArchive = `/tmp/sandcastle-copyin-${randomUUID()}.tar.gz`;
          try {
            await execFileAsync("tar", ["-czf", archive, "-C", hostPath, "."]);
            await machine.writeFile(guestArchive, await readFile(archive));
            await execOk(
              `mkdir -p ${quote(sandboxPath)} && tar -xzf ${quote(guestArchive)} -C ${quote(sandboxPath)}`,
            );
          } finally {
            await machine.exec(["rm", "-f", guestArchive]).catch(() => {});
            await rm(directory, { recursive: true, force: true });
          }
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          const content = await machine.readFile(sandboxPath);
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, content);
        },
        close: async () => {
          if (closed) return;
          await machine.delete();
          closed = true;
        },
      };
    },
  });
