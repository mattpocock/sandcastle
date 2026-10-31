import * as clack from "@clack/prompts";
import { FileSystem } from "@effect/platform";
import { dirname } from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import { styleText } from "node:util";

export type Severity = "info" | "success" | "warn" | "error";

export type DisplayEntry =
  | { readonly _tag: "intro"; readonly title: string }
  | {
      readonly _tag: "status";
      readonly message: string;
      readonly severity: Severity;
    }
  | { readonly _tag: "spinner"; readonly message: string }
  | {
      readonly _tag: "summary";
      readonly title: string;
      readonly rows: Record<string, string>;
    }
  | {
      readonly _tag: "taskLog";
      readonly title: string;
      readonly messages: readonly string[];
    }
  | { readonly _tag: "text"; readonly message: string }
  | { readonly _tag: "textChunk"; readonly message: string }
  | {
      readonly _tag: "toolCall";
      readonly name: string;
      readonly formattedArgs: string;
    };

export interface DisplayService {
  readonly intro: (title: string) => Effect.Effect<void>;

  readonly status: (message: string, severity: Severity) => Effect.Effect<void>;

  readonly spinner: <A, E, R>(
    message: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly summary: (
    title: string,
    rows: Record<string, string>,
  ) => Effect.Effect<void>;

  readonly taskLog: <A, E, R>(
    title: string,
    effect: (message: (msg: string) => void) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  readonly text: (message: string) => Effect.Effect<void>;

  /**
   * Writes a raw streaming chunk with no implied line break. Used for
   * token-by-token agent output, where consecutive chunks must flow together
   * as contiguous prose rather than each landing on its own line.
   */
  readonly textChunk: (chunk: string) => Effect.Effect<void>;

  readonly toolCall: (
    name: string,
    formattedArgs: string,
  ) => Effect.Effect<void>;
}

export class Display extends Context.Tag("@ai-hero/sandcastle/Display")<
  Display,
  DisplayService
>() {}

export const SilentDisplay = {
  layer: (ref: Ref.Ref<readonly DisplayEntry[]>): Layer.Layer<Display> =>
    Layer.succeed(Display, {
      intro: (title) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "intro" as const, title },
        ]),

      status: (message, severity) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "status" as const, message, severity },
        ]),

      spinner: (message, effect) =>
        Effect.flatMap(
          Ref.update(ref, (entries) => [
            ...entries,
            { _tag: "spinner" as const, message },
          ]),
          () => effect,
        ),

      summary: (title, rows) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "summary" as const, title, rows },
        ]),

      taskLog: (title, effect) => {
        const messages: string[] = [];
        return Effect.flatMap(
          effect((msg) => messages.push(msg)),
          (result) =>
            Effect.map(
              Ref.update(ref, (entries) => [
                ...entries,
                {
                  _tag: "taskLog" as const,
                  title,
                  messages: [...messages],
                },
              ]),
              () => result,
            ),
        );
      },

      text: (message) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "text" as const, message },
        ]),

      textChunk: (chunk) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "textChunk" as const, message: chunk },
        ]),

      toolCall: (name, formattedArgs) =>
        Ref.update(ref, (entries) => [
          ...entries,
          { _tag: "toolCall" as const, name, formattedArgs },
        ]),
    }),
};

export const FileDisplay = {
  layer: (
    filePath: string,
  ): Layer.Layer<Display, never, FileSystem.FileSystem> =>
    Layer.effect(
      Display,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .makeDirectory(dirname(filePath), { recursive: true })
          .pipe(Effect.orDie);
        const delimiter = `\n--- Run started: ${new Date().toISOString()} ---\n`;
        yield* fs
          .writeFileString(filePath, delimiter, { flag: "a" })
          .pipe(Effect.orDie);

        // Tracks whether the last write left the cursor mid-line (a raw chunk
        // with no trailing newline). Line-oriented entries consult this so they
        // always begin on a fresh line, keeping structured output (tool calls,
        // status, context-window summaries) off the tail of streamed prose.
        let midLine = false;

        const appendToLog = (line: string): Effect.Effect<void> =>
          Effect.suspend(() => {
            const prefix = midLine ? "\n" : "";
            midLine = false;
            return fs
              .writeFileString(filePath, `${prefix}${line}\n`, { flag: "a" })
              .pipe(Effect.ignore);
          });

        const appendRaw = (chunk: string): Effect.Effect<void> =>
          Effect.suspend(() => {
            if (chunk.length === 0) {
              return Effect.void;
            }
            midLine = !chunk.endsWith("\n");
            return fs
              .writeFileString(filePath, chunk, { flag: "a" })
              .pipe(Effect.ignore);
          });

        return {
          intro: () => Effect.void,

          status: (message, _severity) =>
            appendToLog(message.replace(/^\[[^\]]+\] /, "")),

          spinner: (message, effect) =>
            Effect.gen(function* () {
              yield* appendToLog(`${message}...`);
              const start = Date.now();
              const result = yield* effect;
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              yield* appendToLog(`${message} done (${elapsed}s)`);
              return result;
            }),

          summary: (title, rows) => {
            const lines = Object.entries(rows)
              .map(([key, value]) => `  ${key}: ${value}`)
              .join("\n");
            return appendToLog(`${title}\n${lines}`);
          },

          taskLog: (title, effect) =>
            Effect.gen(function* () {
              yield* appendToLog(title);
              const start = Date.now();
              const messages: string[] = [];
              const result = yield* effect((msg) => {
                messages.push(msg);
              });
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              for (const msg of messages) {
                yield* appendToLog(`  ${msg}`);
              }
              yield* appendToLog(`${title} done (${elapsed}s)`);
              return result;
            }),

          text: (message) => appendToLog(message),

          textChunk: (chunk) => appendRaw(chunk),

          toolCall: (name, formattedArgs) =>
            appendToLog(`${name}(${formattedArgs})`),
        };
      }),
    ),
};

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
  const trimmed = text.replaceAll(/^\n+|\n+$/g, "");
  if (trimmed.trim().length > 0) {
    clack.log.message(trimmed);
  }
};

export const ClackDisplay = {
  layer: Layer.scoped(
    Display,
    Effect.gen(function* () {
      // Each clack.log.message() call is its own message on its own line, so
      // streamed text chunks are held here until a whole line is ready —
      // otherwise a chunk boundary that falls mid-word ("comm" / "ands")
      // splits the word across messages. The pending partial line is flushed
      // before any other output (tool calls, status, …) to keep ordering, and
      // when the layer is released. Mirrors FileDisplay's `midLine`.
      let pendingText = "";

      const flushText = () => {
        const text = pendingText;
        pendingText = "";
        printClackText(text);
      };

      const writeText = (chunk: string) => {
        pendingText += chunk;
        const lastNewline = pendingText.lastIndexOf("\n");
        if (lastNewline === -1) {
          return;
        }
        const complete = pendingText.slice(0, lastNewline);
        pendingText = pendingText.slice(lastNewline + 1);
        printClackText(complete);
      };

      const sync = (f: () => void) =>
        Effect.sync(() => {
          flushText();
          f();
        });

      yield* Effect.addFinalizer(() => Effect.sync(flushText));

      return {
        intro: (title) =>
          sync(() => {
            clack.intro(styleText("inverse", ` ${title} `));
          }),

        status: (message, severity) =>
          sync(() => {
            severityToClack[severity](terminalStyle.status(message));
          }),

        spinner: (message, effect) =>
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
          ),

        summary: (title, rows) =>
          sync(() => {
            const lines = Object.entries(rows)
              .map(([key, value]) => terminalStyle.summaryRow(key, value))
              .join("\n");
            clack.note(lines, terminalStyle.summaryTitle(title));
          }),

        taskLog: (title, effect) =>
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
          ),

        text: (message) =>
          sync(() => {
            clack.log.message(message);
          }),

        textChunk: (chunk) =>
          Effect.sync(() => {
            writeText(chunk);
          }),

        toolCall: (name, formattedArgs) =>
          sync(() => {
            clack.log.step(terminalStyle.toolCall(`${name}(${formattedArgs})`));
          }),
      };
    }),
  ),
};
