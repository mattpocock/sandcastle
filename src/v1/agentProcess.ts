import type { WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { Effect, Queue } from "effect";
import { BoundedTail } from "../boundedTail.js";
import type { HostCommand } from "./hostCommand.js";
import { startHostCommand } from "./hostCommand.js";

// An agent CLI running inside the sandbox, as the supervisor sees it: a queue
// of stdout lines, then its exit. A kill takes everything it started too (its
// process group, or on Windows its process tree): a child holding stdout open
// is exactly the hang the closing-tag grace window exists for.

/** Something that happened to the agent process, or a request to stop it. */
export type AgentItem =
  | { readonly _tag: "line"; readonly line: string }
  | { readonly _tag: "exit"; readonly code: number; readonly error?: string }
  | { readonly _tag: "kill"; readonly reason: "aborted" | "time-limit" }
  /** A message was written to its stdin: the session's timeouts start over. */
  | { readonly _tag: "input" };

/** A running agent process. */
export interface AgentProcess {
  /** Its stdout lines and its exit, in order. `kill()` requests land here too. */
  readonly items: Queue.Queue<AgentItem>;
  /** Kills the process and everything it started. */
  readonly killGroup: Effect.Effect<void>;
  /** The last of what it printed, stdout and stderr together. */
  readonly tail: () => string;
  /** Writes to its stdin, when that was kept open. */
  readonly write: (text: string) => void;
  /** Closes its stdin. Safe to call twice. */
  readonly endInput: () => void;
}

/** Writes the prompt to the agent's stdin, and closes it unless it's kept open for more. */
const stdinOf = (
  stdin: Writable | null,
  options: {
    readonly stdin: string | undefined;
    readonly keepInputOpen: boolean;
  },
): Pick<AgentProcess, "write" | "endInput"> => {
  if (stdin === null) {
    return { write: () => undefined, endInput: () => undefined };
  }
  // An agent that exits without reading its prompt closes the pipe early.
  stdin.on("error", () => undefined);
  if (options.keepInputOpen) {
    stdin.write(options.stdin ?? "");
  } else {
    stdin.end(options.stdin ?? "");
  }
  return {
    write: (text) => {
      if (stdin.writable) {
        stdin.write(text);
      }
    },
    endInput: () => {
      stdin.end();
    },
  };
};

/** An agent that couldn't be started: it has already exited. */
const notStarted = (
  items: Queue.Queue<AgentItem>,
  error: string,
): AgentProcess => {
  Queue.unsafeOffer(items, { _tag: "exit", code: 127, error });
  return {
    items,
    killGroup: Effect.void,
    tail: () => error,
    write: () => undefined,
    endInput: () => undefined,
  };
};

/** Each stdout line logged and queued, and the output kept in `tail`. */
const watch = (
  command: HostCommand,
  options: { readonly log: WriteStream; readonly tail: BoundedTail },
  offer: (item: AgentItem) => void,
): void => {
  const exited = async (): Promise<void> => {
    const { exitCode, error } = await command.exited;
    offer({
      _tag: "exit",
      code: exitCode,
      ...(error === undefined ? {} : { error }),
    });
  };
  void exited();
  command.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    options.tail.push(chunk);
  });
  createInterface({ input: command.stdout }).on("line", (line) => {
    options.tail.push(`${line}\n`);
    options.log.write(`${line}\n`);
    offer({ _tag: "line", line });
  });
};

/**
 * Starts the agent's command (`sh -c` in its own process group, or on
 * Windows the command's own argv, with no `sh`), writing each stdout line to
 * `log`.
 */
export const startAgentProcess = (options: {
  readonly command: string;
  readonly workingDirectory: string;
  readonly stdin: string | undefined;
  /** Keep stdin open after `stdin` for later writes, until `endInput()`. */
  readonly keepInputOpen: boolean;
  readonly log: WriteStream;
}): Effect.Effect<AgentProcess> =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<AgentItem>();
    const started = yield* Effect.either(
      Effect.tryPromise(async () =>
        startHostCommand({
          command: options.command,
          cwd: options.workingDirectory,
          env: process.env,
          stdin: "pipe",
        }),
      ),
    );
    if (started._tag === "Left") {
      const { error } = started.left;
      return notStarted(
        items,
        error instanceof Error ? error.message : String(error),
      );
    }
    const command = started.right;
    const tail = new BoundedTail(16 * 1024);
    watch(command, { log: options.log, tail }, (item) => {
      Queue.unsafeOffer(items, item);
    });
    return {
      items,
      killGroup: Effect.promise(command.kill),
      tail: () => tail.toString(),
      ...stdinOf(command.stdin, options),
    };
  });
