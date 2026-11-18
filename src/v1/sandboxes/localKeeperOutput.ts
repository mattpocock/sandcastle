import type { KeeperReply } from "./localKeeperProtocol.js";

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
