import { once } from "node:events";
import type { Sprite, SpriteCommand } from "@fly/sprites";
import { BoundedTail, MAX_TAIL_CHARS } from "../../boundedTail.js";
import type { ProviderExecResult } from "../SandboxProvider.js";

// One `sh -c` over the Sprites exec WebSocket: stdin written and closed,
// stdout lines passed on as they arrive, stderr kept apart. Env never goes
// through the SDK's own `env` option, which puts it in the WebSocket URL's
// query string, where the SDK's connection errors print it.

/** The exit code of a command killed through its abort signal (SIGTERM). */
const ABORTED_EXIT_CODE = 143;

/** How one command's output is wanted. */
export interface StreamOptions {
  readonly stdin?: string;
  readonly onLine?: (line: string) => void;
  readonly abortSignal?: AbortSignal;
}

/** Drops the query string and fragment from every URL in `text`. */
export const stripUrlQueries = (text: string): string =>
  text.replaceAll(
    /(?<url>(?:wss?|https?):\/\/[^\s?#)]*)[?#][^\s)]*/giu,
    "$<url>",
  );

/**
 * The error for a failed exec connection. The SDK's error names the exec
 * URL, so the error and its `cause` keep only the URL's path.
 */
export const connectionError = (error: unknown): Error => {
  const sdkError = error instanceof Error ? error : new Error(String(error));
  const cause = new Error(stripUrlQueries(sdkError.message));
  cause.name = sdkError.name;
  cause.stack =
    sdkError.stack === undefined ? undefined : stripUrlQueries(sdkError.stack);
  return new Error(`sprites: the exec connection failed: ${cause.message}`, {
    cause,
  });
};

/** Collects a command's output, passing each stdout line on as it arrives. */
const collector = (onLine: ((line: string) => void) | undefined) => {
  const stdout = new BoundedTail(MAX_TAIL_CHARS, "");
  const stderr = new BoundedTail(MAX_TAIL_CHARS, "");
  let partial = "";
  return {
    onStdout: (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout.push(text);
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(line);
      }
    },
    onStderr: (chunk: Buffer) => {
      stderr.push(chunk.toString("utf8"));
    },
    result: (exitCode: number): ProviderExecResult => {
      if (partial !== "") {
        onLine?.(partial);
        partial = "";
      }
      return {
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      };
    },
  };
};

/**
 * Resolves with the exit code, once both output streams have ended too, or
 * with `"aborted"`. `once` rejects if the exec emits "error" (a failed
 * connection) first.
 */
const endOf = async (
  proc: SpriteCommand,
  abortSignal: AbortSignal | undefined,
): Promise<number | "aborted"> => {
  if (abortSignal?.aborted === true) {
    return "aborted";
  }
  const exited = Promise.all([
    once(proc, "exit"),
    once(proc.stdout, "end"),
    once(proc.stderr, "end"),
  ]).then(([[code]]): number => (typeof code === "number" ? code : -1));
  if (abortSignal === undefined) {
    return exited.catch((error: unknown) => {
      throw connectionError(error);
    });
  }
  const stopWatching = new AbortController();
  const aborted = once(abortSignal, "abort", {
    signal: stopWatching.signal,
  }).then(
    () => "aborted" as const,
    () => "aborted" as const,
  );
  return Promise.race([exited, aborted])
    .catch((error: unknown) => {
      throw connectionError(error);
    })
    .finally(() => {
      stopWatching.abort();
    });
};

/** Runs `sh -c line` in the sprite and waits for it. */
export const streamCommand = async (
  sprite: Sprite,
  line: string,
  options: StreamOptions,
): Promise<ProviderExecResult> => {
  const proc = sprite.spawn("sh", ["-c", line]);
  const output = collector(options.onLine);
  proc.stdout.on("data", output.onStdout);
  proc.stderr.on("data", output.onStderr);
  proc.once("spawn", () => {
    proc.stdin.end(options.stdin ?? "");
  });
  // A late error, after the command has ended, must not crash the host.
  proc.on("error", () => undefined);
  const ended = await endOf(proc, options.abortSignal).catch(
    (error: unknown) => {
      proc.close();
      throw error;
    },
  );
  if (ended === "aborted") {
    proc.kill("SIGTERM");
  }
  proc.close();
  if (ended === "aborted") {
    return output.result(ABORTED_EXIT_CODE);
  }
  if (ended < 0) {
    throw new Error("sprites: the connection closed before the command exited");
  }
  return output.result(ended);
};
