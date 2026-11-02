import { FileSystem } from "@effect/platform";
import { dirname } from "node:path";
import { Clock, Context, DateTime, Effect, Layer, Ref } from "effect";

import { makeClackDisplayService } from "./clackDisplayService.js";
import type { DisplayEntry, DisplayService } from "./DisplayService.js";

export type {
  DisplayEntry,
  DisplayService,
  Severity,
} from "./DisplayService.js";
export { terminalStyle } from "./clackDisplayService.js";

export class Display extends Context.Tag("@ai-hero/sandcastle/Display")<
  Display,
  DisplayService
>() {}

const silentDisplayService = (
  ref: Ref.Ref<readonly DisplayEntry[]>,
): DisplayService => {
  const record = (entry: DisplayEntry): Effect.Effect<void> =>
    Ref.update(ref, (entries) => [...entries, entry]);
  return {
    intro: (title) => record({ _tag: "intro", title }),
    status: (message, severity) =>
      record({ _tag: "status", message, severity }),
    spinner: (message, effect) =>
      record({ _tag: "spinner", message }).pipe(Effect.andThen(effect)),
    summary: (title, rows) => record({ _tag: "summary", title, rows }),
    taskLog: (title, effect) => {
      const messages: string[] = [];
      return Effect.flatMap(
        effect((msg) => {
          messages.push(msg);
        }),
        (result) =>
          Effect.as(
            record({ _tag: "taskLog", title, messages: [...messages] }),
            result,
          ),
      );
    },
    text: (message) => record({ _tag: "text", message }),
    textChunk: (chunk) => record({ _tag: "textChunk", message: chunk }),
    toolCall: (name, formattedArgs) =>
      record({ _tag: "toolCall", name, formattedArgs }),
  };
};

export const SilentDisplay = {
  layer: (ref: Ref.Ref<readonly DisplayEntry[]>): Layer.Layer<Display> =>
    Layer.succeed(Display, silentDisplayService(ref)),
};

interface LogWriter {
  /** Appends a whole line, first ending any line a raw chunk left open. */
  readonly appendToLog: (line: string) => Effect.Effect<void>;
  /** Appends a raw chunk with no implied line break. */
  readonly appendRaw: (chunk: string) => Effect.Effect<void>;
}

const makeLogWriter = (
  fs: FileSystem.FileSystem,
  filePath: string,
): LogWriter => {
  // Tracks whether the last write left the cursor mid-line (a raw chunk
  // with no trailing newline). Line-oriented entries consult this so they
  // always begin on a fresh line, keeping structured output (tool calls,
  // status, context-window summaries) off the tail of streamed prose.
  let midLine = false;
  return {
    appendToLog: (line) =>
      Effect.suspend(() => {
        const prefix = midLine ? "\n" : "";
        midLine = false;
        return fs
          .writeFileString(filePath, `${prefix}${line}\n`, { flag: "a" })
          .pipe(Effect.ignore);
      }),
    appendRaw: (chunk) =>
      Effect.suspend(() => {
        if (chunk.length === 0) {
          return Effect.void;
        }
        midLine = !chunk.endsWith("\n");
        return fs
          .writeFileString(filePath, chunk, { flag: "a" })
          .pipe(Effect.ignore);
      }),
  };
};

/** Seconds since `start` (a Clock millis reading), to one decimal place. */
const elapsedSince = (start: number): Effect.Effect<string> =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => ((now - start) / 1000).toFixed(1)),
  );

const fileDisplayService = ({
  appendToLog,
  appendRaw,
}: LogWriter): DisplayService => ({
  intro: () => Effect.void,

  status: (message, _severity) =>
    appendToLog(message.replace(/^\[[^\]]+\] /u, "")),

  spinner: (message, effect) =>
    Effect.gen(function* () {
      yield* appendToLog(`${message}...`);
      const start = yield* Clock.currentTimeMillis;
      const result = yield* effect;
      const elapsed = yield* elapsedSince(start);
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
      const start = yield* Clock.currentTimeMillis;
      const messages: string[] = [];
      const result = yield* effect((msg) => {
        messages.push(msg);
      });
      const elapsed = yield* elapsedSince(start);
      for (const msg of messages) {
        yield* appendToLog(`  ${msg}`);
      }
      yield* appendToLog(`${title} done (${elapsed}s)`);
      return result;
    }),

  text: (message) => appendToLog(message),

  textChunk: (chunk) => appendRaw(chunk),

  toolCall: (name, formattedArgs) => appendToLog(`${name}(${formattedArgs})`),
});

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
        const delimiter = `\n--- Run started: ${DateTime.formatIso(yield* DateTime.now)} ---\n`;
        yield* fs
          .writeFileString(filePath, delimiter, { flag: "a" })
          .pipe(Effect.orDie);
        return fileDisplayService(makeLogWriter(fs, filePath));
      }),
    ),
};

export const ClackDisplay = {
  layer: Layer.scoped(Display, makeClackDisplayService),
};
