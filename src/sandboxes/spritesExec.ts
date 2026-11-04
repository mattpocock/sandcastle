/**
 * `exec` for the Fly.io Sprites provider (`sprites.ts`): runs a command over
 * the `@fly/sprites` exec WebSocket and streams its stdout lines.
 */

import { once } from "node:events";
import type { ExecResult } from "../SandboxProvider.js";
import { BoundedTail } from "../boundedTail.js";
import type { Sprite } from "@fly/sprites";

/** What one `exec` in a Sprite needs. */
export interface SpriteExecRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly onLine?: (line: string) => void;
  readonly sudo?: boolean;
  readonly stdin?: string;
  /** Bound on the stdout and stderr tails of a streamed `exec`. */
  readonly maxOutputTailChars: number;
}

const shellEscape = (s: string): string =>
  `'${s.replaceAll("'", String.raw`'\''`)}'`;

/**
 * A sink for one output stream. Streamed: each complete line goes to
 * `onLine` at once and into a bounded tail, and `flush()` hands over a last
 * line that has no trailing newline. Buffered: the whole output is kept.
 */
const outputSink = (
  separator: string,
  maxChars: number | undefined,
  onLine?: (line: string) => void,
) => {
  const chunks: string[] = [];
  const tail = new BoundedTail(maxChars, separator);
  let partial = "";
  const emit = (line: string): void => {
    tail.push(line);
    onLine?.(line);
  };
  return {
    push: (chunk: Buffer): void => {
      if (maxChars === undefined) {
        chunks.push(chunk.toString());
        return;
      }
      if (onLine === undefined) {
        tail.push(chunk.toString());
        return;
      }
      const lines = (partial + chunk.toString()).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        emit(line);
      }
    },
    flush: (): void => {
      if (partial !== "") {
        emit(partial);
        partial = "";
      }
    },
    toString: (): string =>
      maxChars === undefined ? chunks.join("") : tail.toString(),
  };
};

/**
 * Run a command in the Sprite. stdin is always sent and closed (empty when
 * unset), so a command that reads it gets EOF rather than waiting. With
 * `onLine`, stdout lines are delivered live as they arrive; without it, the
 * whole stdout comes back, as sync-out needs.
 */
export const execInSprite = async (
  sprite: Sprite,
  request: SpriteExecRequest,
): Promise<ExecResult> => {
  const { command, onLine, maxOutputTailChars } = request;
  const line =
    request.sudo === true ? `sudo sh -c ${shellEscape(command)}` : command;
  const proc = sprite.spawn("sh", ["-c", line], {
    cwd: request.cwd,
    env: request.env,
  });
  const streamed = onLine !== undefined;
  const stdout = outputSink(
    "\n",
    streamed ? maxOutputTailChars : undefined,
    onLine,
  );
  const stderr = outputSink("", streamed ? maxOutputTailChars : undefined);
  proc.stdout.on("data", stdout.push);
  proc.stderr.on("data", stderr.push);
  proc.once("spawn", () => {
    proc.stdin.end(request.stdin ?? "");
  });
  // A late error, after the command has exited, must not crash the process.
  proc.on("error", () => undefined);
  // `once` rejects if the command emits "error" (a failed connection) first.
  // The SDK ends both streams on exit; wait for them so no chunk is missed.
  const [exitArgs]: unknown[][] = await Promise.all([
    once(proc, "exit"),
    once(proc.stdout, "end"),
    once(proc.stderr, "end"),
  ]);
  const exitCode = exitArgs?.[0];
  stdout.flush();
  if (typeof exitCode !== "number" || exitCode < 0) {
    throw new Error(
      `sprites(): the connection closed before the command exited: ${command}`,
    );
  }
  return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode };
};
