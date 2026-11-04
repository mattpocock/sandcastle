import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  ProviderExecOptions,
  ProviderExecResult,
  ProviderSandbox,
} from "@ai-hero/sandcastle/v1";

// The operations of a provider sandbox, run for real in a host directory:
// `sh -c` commands (each in its own process group, all killed by `close`)
// and plain files. For tests of createSandbox through a hand-built provider,
// which still has to run the session supervisor. POSIX only.

type Operations = Pick<
  ProviderSandbox,
  "exec" | "readTextFile" | "writeTextFile" | "close"
>;

const kill = (pid: number | undefined): void => {
  try {
    if (pid !== undefined) {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
};

export const localProviderSandbox = (dir: string): Operations => {
  const running = new Set<number | undefined>();
  const exec = async (
    options: ProviderExecOptions,
  ): Promise<ProviderExecResult> => {
    const child = spawn("sh", ["-c", options.command], {
      cwd: path.resolve(dir, options.workingDirectory ?? "."),
      env: { ...process.env, HOME: dir, ...options.env },
      detached: true,
    });
    running.add(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    if (options.onLine !== undefined) {
      createInterface({ input: child.stdout }).on("line", options.onLine);
    }
    child.stdin.on("error", () => undefined).end(options.stdin ?? "");
    options.abortSignal?.addEventListener("abort", () => {
      kill(child.pid);
    });
    const closed: unknown[] = await once(child, "close");
    running.delete(child.pid);
    const [code] = closed;
    return { exitCode: typeof code === "number" ? code : 137, stdout, stderr };
  };
  return {
    exec,
    readTextFile: async ({ path: file }) =>
      readFile(path.resolve(dir, file), "utf8").catch(() => null),
    writeTextFile: async ({ path: file, content }) => {
      const target = path.resolve(dir, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    close: async () => {
      for (const pid of running) {
        kill(pid);
      }
    },
  };
};
