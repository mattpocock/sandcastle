import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { registerShutdown } from "./shutdownRegistry.js";

/**
 * Run a shell command on the host and resolve with its output, like
 * `promisify(exec)`, but stop the command's whole process tree when any of
 * `signals` aborts.
 *
 * `exec`'s own `signal` option kills only the shell it spawns, so anything the
 * command started (`sleep 15; echo late > f` runs `sleep` as a grandchild) keeps
 * running after the caller has given up. Here the shell leads its own process
 * group and an abort kills the group. While the command runs, a shutdown
 * teardown kills the group too, because a detached group no longer receives
 * the terminal's Ctrl-C.
 *
 * On Windows there are no process groups, so an abort kills the shell only.
 */
export const execHostShell = (
  command: string,
  options: {
    readonly cwd: string;
    readonly signals: readonly (AbortSignal | undefined)[];
  },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const signals = options.signals.filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const aborted = signals.find((s) => s.aborted);
    if (aborted) {
      reject(abortError(command, aborted));
      return;
    }

    const usesProcessGroup = process.platform !== "win32";
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: usesProcessGroup,
    });

    const tree = treeKiller(child, usesProcessGroup);
    const stopListening = onAnyAbort(signals, (signal) => {
      tree.kill();
      reject(abortError(command, signal));
    });
    const unregisterShutdown = registerShutdown(tree.kill);
    const finish = () => {
      tree.markExited();
      stopListening();
      unregisterShutdown();
    };
    const output = collectOutput(child);

    child.on("error", (err) => {
      finish();
      reject(err);
    });
    child.on("close", (code, killSignal) => {
      finish();
      if (code === 0) {
        resolve({ stdout: output.stdout, stderr: output.stderr });
        return;
      }
      reject(commandFailed(command, output, { code, signal: killSignal }));
    });
  });

/**
 * Kills the child's process group (or only the shell, on Windows) until it
 * is marked exited. Errors are swallowed: the process may already be gone.
 */
const treeKiller = (child: ChildProcess, usesProcessGroup: boolean) => {
  let exited = false;
  const kill = () => {
    if (exited || child.pid === undefined) {
      return;
    }
    try {
      if (usesProcessGroup) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // Already gone.
    }
  };
  const markExited = () => {
    exited = true;
  };
  return { kill, markExited };
};

/** Calls `onAbort` when any of `signals` aborts. Returns a function that stops listening. */
const onAnyAbort = (
  signals: readonly AbortSignal[],
  onAbort: (signal: AbortSignal) => void,
): (() => void) => {
  const listeners = signals.map((signal) => {
    const listener = () => {
      onAbort(signal);
    };
    signal.addEventListener("abort", listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
  };
};

/** Accumulates the child's stdout and stderr as UTF-8 text. */
const collectOutput = (
  child: ChildProcess,
): { stdout: string; stderr: string } => {
  const output = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8").on("data", (d: string) => {
    output.stdout += d;
  });
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    output.stderr += d;
  });
  return output;
};

/** The error for a non-zero exit, shaped like `exec`'s (code, signal, stdout, stderr). */
const commandFailed = (
  command: string,
  output: { readonly stdout: string; readonly stderr: string },
  exit: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  },
): Error =>
  Object.assign(new Error(`Command failed: ${command}\n${output.stderr}`), {
    code: exit.code,
    signal: exit.signal,
    stdout: output.stdout,
    stderr: output.stderr,
  });

const abortError = (command: string, signal: AbortSignal): Error =>
  Object.assign(
    new Error(`Command aborted: ${command} (${String(signal.reason)})`),
    { name: "AbortError" },
  );
