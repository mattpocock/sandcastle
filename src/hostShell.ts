import { spawn } from "node:child_process";
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

    let exited = false;
    const killTree = () => {
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

    const abortListeners = signals.map((signal) => {
      const onAbort = () => {
        killTree();
        reject(abortError(command, signal));
      };
      signal.addEventListener("abort", onAbort);
      return { signal, onAbort };
    });
    const unregisterShutdown = registerShutdown(killTree);
    const cleanup = () => {
      for (const { signal, onAbort } of abortListeners) {
        signal.removeEventListener("abort", onAbort);
      }
      unregisterShutdown();
    };

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));

    child.on("error", (err) => {
      exited = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code, killSignal) => {
      exited = true;
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        Object.assign(new Error(`Command failed: ${command}\n${stderr}`), {
          code,
          signal: killSignal,
          stdout,
          stderr,
        }),
      );
    });
  });

const abortError = (command: string, signal: AbortSignal): Error =>
  Object.assign(
    new Error(`Command aborted: ${command} (${String(signal.reason)})`),
    { name: "AbortError" },
  );
