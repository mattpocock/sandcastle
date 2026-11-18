import { Schema } from "effect";

// What the host and a local sandbox's keeper say to each other over the
// keeper's socket: one JSON request line per connection, then reply lines.
// Provider-agnostic: a request carries the whole argv to run, so the keeper
// never knows which tool (bwrap, sandbox-exec…) makes the sandbox.

const Env = Schema.Record({ key: Schema.String, value: Schema.String });
/**
 * Kill the command's process group as soon as it exits, so nothing it
 * started outlives it: for a provider with no PID namespace to do that.
 */
const EndGroupOnExit = Schema.optional(Schema.Boolean);

/** A request to the keeper. */
export const KeeperRequest = Schema.Union(
  /** Is the keeper there? Replies `pong`. */
  Schema.Struct({ type: Schema.Literal("ping") }),
  /**
   * Runs `argv` with exactly `env`, `stdin` written and closed, streaming
   * `stdout`/`stderr` replies and then `exit`. Killed if the connection
   * closes first.
   */
  Schema.Struct({
    type: Schema.Literal("exec"),
    argv: Schema.NonEmptyArray(Schema.String),
    env: Env,
    stdin: Schema.String,
    endGroupOnExit: EndGroupOnExit,
  }),
  /** Starts `argv` with exactly `env`, owned by the keeper alone. Replies `spawned` once it's running. */
  Schema.Struct({
    type: Schema.Literal("spawn"),
    argv: Schema.NonEmptyArray(Schema.String),
    env: Env,
    endGroupOnExit: EndGroupOnExit,
  }),
  /** Kills everything and removes the folder. Replies `closed` once it's gone. */
  Schema.Struct({ type: Schema.Literal("close") }),
);
export type KeeperRequest = typeof KeeperRequest.Type;

/** A reply from the keeper. */
export const KeeperReply = Schema.Union(
  Schema.Struct({ type: Schema.Literal("pong") }),
  Schema.Struct({ type: Schema.Literal("stdout"), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stderr"), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("exit"), code: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("spawned") }),
  Schema.Struct({ type: Schema.Literal("closed") }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
);
export type KeeperReply = typeof KeeperReply.Type;

/** One request or reply as a line. */
export const encodeKeeperLine = (
  message: KeeperRequest | KeeperReply,
): string => `${JSON.stringify(message)}\n`;

export const decodeKeeperRequest = Schema.decodeUnknownEither(
  Schema.parseJson(KeeperRequest),
);
export const decodeKeeperReply = Schema.decodeUnknownEither(
  Schema.parseJson(KeeperReply),
);

/** The line the keeper prints on stdout once its socket is listening. */
export const KEEPER_READY = "ready";

// A command's output as the keeper's replies stream it in.

/** Splits streamed text into lines as they complete. */
export const lineSplitter = (onLine: ((line: string) => void) | undefined) => {
  let partial = "";
  return {
    push: (data: string): void => {
      const lines = `${partial}${data}`.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(line);
      }
    },
    end: (): void => {
      if (partial !== "") {
        onLine?.(partial);
      }
    },
  };
};

/** A command's output so far, as its replies arrive. */
export interface Collected {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/** No output yet. */
export const emptyOutput = (): Collected => ({ stdout: "", stderr: "" });

/** Adds one reply to `output`, handing each finished stdout line to `lines`. */
export const collect = (
  output: Collected,
  lines: ReturnType<typeof lineSplitter>,
  reply: KeeperReply,
): void => {
  switch (reply.type) {
    case "pong":
    case "spawned":
    case "closed": {
      return;
    }
    case "stdout": {
      output.stdout += reply.data;
      lines.push(reply.data);
      return;
    }
    case "stderr": {
      output.stderr += reply.data;
      return;
    }
    case "exit": {
      output.exitCode = reply.code;
      return;
    }
    case "error": {
      output.stderr += reply.message;
    }
  }
};
