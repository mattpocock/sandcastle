/**
 * The terminal display: every Display call rendered through @clack/prompts.
 */
import * as clack from "@clack/prompts";
import { Effect } from "effect";
import type { Scope } from "effect";
import { styleText } from "node:util";
import type { DisplayService, Severity } from "./DisplayService.js";

const severityToClack: Record<Severity, (message: string) => void> = {
  info: clack.log.info,
  success: clack.log.success,
  warn: clack.log.warning,
  error: clack.log.error,
};

export const terminalStyle = {
  status: (message: string): string => styleText("bold", message),
  summaryTitle: (title: string): string => styleText("bold", title),
  summaryRow: (key: string, value: string): string =>
    `${styleText("bold", key)}: ${styleText("dim", value)}`,
  toolCall: (text: string): string => styleText("dim", text),
};

/** Prints a text chunk via clack, dropping leading/trailing blank lines. */
const printClackText = (text: string) => {
  const trimmed = text.replaceAll(/^\n+|\n+$/gu, "");
  if (trimmed.trim().length > 0) {
    clack.log.message(trimmed);
  }
};

interface TextBuffer {
  /** Prints the pending partial line, if any. */
  readonly flush: () => void;
  /** Adds a chunk, printing every line it completes. */
  readonly write: (chunk: string) => void;
}

/**
 * Each clack.log.message() call is its own message on its own line, so
 * streamed text chunks are held here until a whole line is ready —
 * otherwise a chunk boundary that falls mid-word ("comm" / "ands")
 * splits the word across messages. The pending partial line is flushed
 * before any other output (tool calls, status, …) to keep ordering, and
 * when the layer is released. Mirrors FileDisplay's `midLine`.
 */
const makeTextBuffer = (): TextBuffer => {
  let pendingText = "";
  return {
    flush: () => {
      const text = pendingText;
      pendingText = "";
      printClackText(text);
    },
    write: (chunk) => {
      pendingText += chunk;
      const lastNewline = pendingText.lastIndexOf("\n");
      if (lastNewline === -1) {
        return;
      }
      const complete = pendingText.slice(0, lastNewline);
      pendingText = pendingText.slice(lastNewline + 1);
      printClackText(complete);
    },
  };
};

const clackSpinner =
  (flushText: () => void): DisplayService["spinner"] =>
  (message, effect) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        flushText();
        const s = clack.spinner();
        s.start(message);
        return s;
      }),
      () => effect,
      (s, exit) =>
        Effect.sync(() => {
          if (exit._tag === "Success") {
            s.stop(message);
          } else {
            s.stop(`${message} (failed)`);
          }
        }),
    );

const clackTaskLog =
  (flushText: () => void): DisplayService["taskLog"] =>
  (title, effect) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        flushText();
        return clack.taskLog({ title });
      }),
      (log) =>
        effect((msg) => {
          log.message(msg);
        }),
      (log, exit) =>
        Effect.sync(() => {
          if (exit._tag === "Success") {
            log.success(title, { showLog: true });
          } else {
            log.error(title, { showLog: true });
          }
        }),
    );

/** The clack DisplayService; flushes buffered text when its scope closes. */
export const makeClackDisplayService: Effect.Effect<
  DisplayService,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const text = makeTextBuffer();
  const sync = (f: () => void) =>
    Effect.sync(() => {
      text.flush();
      f();
    });

  yield* Effect.addFinalizer(() => Effect.sync(text.flush));

  return {
    intro: (title) =>
      sync(() => {
        clack.intro(styleText("inverse", ` ${title} `));
      }),
    status: (message, severity) =>
      sync(() => {
        severityToClack[severity](terminalStyle.status(message));
      }),
    spinner: clackSpinner(text.flush),
    summary: (title, rows) =>
      sync(() => {
        const lines = Object.entries(rows)
          .map(([key, value]) => terminalStyle.summaryRow(key, value))
          .join("\n");
        clack.note(lines, terminalStyle.summaryTitle(title));
      }),
    taskLog: clackTaskLog(text.flush),
    text: (message) =>
      sync(() => {
        clack.log.message(message);
      }),
    textChunk: (chunk) =>
      Effect.sync(() => {
        text.write(chunk);
      }),
    toolCall: (name, formattedArgs) =>
      sync(() => {
        clack.log.step(terminalStyle.toolCall(`${name}(${formattedArgs})`));
      }),
  };
});
