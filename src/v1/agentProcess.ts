import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import { Effect, Queue } from "effect";
import { BoundedTail } from "../boundedTail.js";

// An agent CLI running inside the sandbox, as the supervisor sees it: a queue
// of stdout lines, then its exit. The process gets its own process group so
// a kill takes its children too: a child holding stdout open is exactly the
// hang the closing-tag grace window exists for.

/** Something that happened to the agent process, or a request to stop it. */
export type AgentItem =
  | { readonly _tag: "line"; readonly line: string }
  | { readonly _tag: "exit"; readonly code: number; readonly error?: string }
  | { readonly _tag: "kill" };

/** A running agent process. */
export interface AgentProcess {
  /** Its stdout lines and its exit, in order. `kill()` requests land here too. */
  readonly items: Queue.Queue<AgentItem>;
  /** Kills the process and everything it started. */
  readonly killGroup: Effect.Effect<void>;
  /** The last of what it printed, stdout and stderr together. */
  readonly tail: () => string;
}

const exitCodeOf = (code: number | null, signal: string | null): number => {
  if (code !== null) {
    return code;
  }
  const signals: Readonly<Record<string, number>> = constants.signals;
  return 128 + (signal === null ? 0 : (signals[signal] ?? 0));
};

const killProcessGroup = (pid: number | undefined): void => {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // It has already exited.
  }
};

/** Starts `sh -c command` in its own process group, writing each stdout line to `log`. */
export const startAgentProcess = (options: {
  readonly command: string;
  readonly workingDirectory: string;
  readonly stdin: string | undefined;
  readonly log: WriteStream;
}): Effect.Effect<AgentProcess> =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<AgentItem>();
    const tail = new BoundedTail(16 * 1024);
    const offer = (item: AgentItem): void => {
      Queue.unsafeOffer(items, item);
    };
    const child = spawn("sh", ["-c", options.command], {
      cwd: options.workingDirectory,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      offer({ _tag: "exit", code: 127, error: error.message });
    });
    child.on("close", (code, signal) => {
      offer({ _tag: "exit", code: exitCodeOf(code, signal) });
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      tail.push(chunk);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      tail.push(`${line}\n`);
      options.log.write(`${line}\n`);
      offer({ _tag: "line", line });
    });
    // An agent that exits without reading its prompt closes the pipe early.
    child.stdin.on("error", () => undefined).end(options.stdin ?? "");
    return {
      items,
      killGroup: Effect.sync(() => {
        killProcessGroup(child.pid);
      }),
      tail: () => tail.toString(),
    };
  });
