/**
 * Splits a child's streamed stdout into lines, the way JSONL defines them.
 *
 * Agent providers write their stdout as JSONL: one JSON value per line. A line
 * ends only at "\n", with an optional "\r" before it. Node's `readline` also
 * ends a line at U+2028 and U+2029, which JSON allows unescaped inside a
 * string, so it cuts valid frames in two. This reader does not.
 */

import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import type { BoundedTail } from "./boundedTail.js";

/**
 * Calls `onLine` once for each line of `stdout`, and pushes each line to `tail`.
 *
 * Decodes UTF-8 as a stream, so a character split across chunks stays whole.
 * A last line without a "\n" is sent when the stream ends.
 */
export const streamStdoutLines = (
  stdout: Readable,
  tail: BoundedTail,
  onLine: (line: string) => void,
): void => {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (line: string): void => {
    tail.push(line);
    onLine(line);
  };
  stdout.on("data", (chunk: Buffer | string) => {
    const text =
      pending + (typeof chunk === "string" ? chunk : decoder.write(chunk));
    let start = 0;
    let end = text.indexOf("\n");
    while (end !== -1) {
      const line = text.slice(start, end);
      emit(line.endsWith("\r") ? line.slice(0, -1) : line);
      start = end + 1;
      end = text.indexOf("\n", start);
    }
    pending = text.slice(start);
  });
  stdout.on("end", () => {
    const rest = pending + decoder.end();
    if (rest !== "") {
      emit(rest);
    }
  });
};
