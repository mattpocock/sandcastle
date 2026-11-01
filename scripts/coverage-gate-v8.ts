// Raw V8 coverage (NODE_V8_COVERAGE) from a CLI process, mapped back to src/
// lines. Used by scripts/coverage-gate.ts to count the CLI subprocesses e2e
// tests spawn. A process runs the CLI one of two ways:
//
// - built: `node dist/main.js`. Mapped through dist's source maps on disk.
// - tsx:   `tsx src/main.ts`, as e2e tests do so the windows job can run
//          them. tsx compiles each src/ file in memory, so there is no file
//          to read; Node puts its source map and line lengths in the
//          report's `source-map-cache` instead.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Lines } from "./coverage-gate-core.ts";

const V8Report = z.object({
  result: z.array(
    z.object({
      url: z.string(),
      functions: z.array(
        z.object({
          ranges: z.array(
            z.object({
              startOffset: z.number(),
              endOffset: z.number(),
              count: z.number(),
            }),
          ),
        }),
      ),
    }),
  ),
});

const SourceMapJson = z.object({
  sources: z.array(z.string()),
  sourceRoot: z.string().optional(),
  mappings: z.string(),
});

/** Node's record of a script's source map, keyed by the script's URL. */
const SourceMapCache = z.record(
  z.string(),
  z.object({
    lineLengths: z.array(z.number()),
    data: SourceMapJson.nullable(),
  }),
);

const V8ReportWithCache = V8Report.extend({
  "source-map-cache": SourceMapCache.optional(),
});

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** One source map segment's fields, each a base64 VLQ, decoded. */
const decodeVlq = (segment: string): number[] => {
  const values: number[] = [];
  let value = 0;
  let scale = 1;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    value += (digit % 32) * scale;
    if (digit < 32) {
      const magnitude = Math.floor(value / 2);
      values.push(value % 2 === 1 ? -magnitude : magnitude);
      value = 0;
      scale = 1;
    } else {
      scale *= 32;
    }
  }
  return values;
};

interface Mapping {
  /** Offset into the generated script. */
  readonly offset: number;
  readonly source: number;
  /** 1-based line in the original source. */
  readonly line: number;
}

/** Every mapping in `mappings`, located by offset via each line's start. */
const decodeMappings = (
  lineStarts: readonly number[],
  mappings: string,
): Mapping[] => {
  const out: Mapping[] = [];
  let source = 0;
  let line = 0;
  for (const [generatedLine, segments] of mappings.split(";").entries()) {
    let column = 0;
    for (const segment of segments.split(",")) {
      const fields = decodeVlq(segment);
      column += fields[0] ?? 0;
      if (fields.length < 4) {
        continue;
      }
      source += fields[1] ?? 0;
      line += fields[2] ?? 0;
      out.push({
        offset: (lineStarts[generatedLine] ?? Number.NaN) + column,
        source,
        line: line + 1,
      });
    }
  }
  return out;
};

type Ranges = z.infer<typeof V8Report>["result"][number]["functions"];

/** Each offset's execution count. */
const countsByOffset = (length: number, functions: Ranges): Float64Array => {
  // V8 block ranges nest, and an offset's count is its innermost range's:
  // paint the ranges outermost first.
  const counts = new Float64Array(length);
  for (const range of functions
    .flatMap((f) => f.ranges)
    .toSorted(
      (a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset),
    )) {
    counts.fill(range.count, range.startOffset, range.endOffset);
  }
  return counts;
};

interface Script {
  /** Absolute path of the script that ran. */
  readonly file: string;
  /** Offset of each line's first character; the last is the script's length. */
  readonly lineStarts: readonly number[];
  readonly map: z.infer<typeof SourceMapJson>;
  readonly functions: Ranges;
  /** Whether a mapping at this offset counts; see `builtScript`. */
  readonly mapsCode: (offset: number) => boolean;
}

const toPath = (url: string): string =>
  url.startsWith("file:") ? fileURLToPath(url) : url;

/** Adds the src/ lines one script ran to `lines`. */
const addScriptLines = (lines: Lines, script: Script, root: string): void => {
  const { map } = script;
  const sources = map.sources.map((source) =>
    path
      .relative(
        root,
        source.startsWith("file:")
          ? fileURLToPath(source)
          : path.resolve(
              path.dirname(script.file),
              map.sourceRoot ?? "",
              source,
            ),
      )
      .replaceAll("\\", "/"),
  );
  const counts = countsByOffset(
    script.lineStarts.at(-1) ?? 0,
    script.functions,
  );
  for (const { offset, source, line } of decodeMappings(
    script.lineStarts,
    map.mappings,
  )) {
    const file = sources[source];
    if (
      file?.startsWith("src/") === true &&
      script.mapsCode(offset) &&
      (counts[offset] ?? 0) > 0
    ) {
      lines.set(file, (lines.get(file) ?? new Set()).add(line));
    }
  }
};

/** Offsets of each line start in `text`, then its length. */
const lineStartsOf = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  starts.push(text.length);
  return starts;
};

/** A built dist/ script, from its text and the source map beside it. */
const builtScript = (
  text: string,
  sourceMap: string,
): Omit<Script, "file" | "functions"> => ({
  lineStarts: lineStartsOf(text),
  map: SourceMapJson.parse(JSON.parse(sourceMap)),
  // A mapping on whitespace (a line's indentation) carries on the source
  // line above, and would count it from the next line's block.
  mapsCode: (offset) => /\S/u.test(text[offset] ?? ""),
});

/**
 * A src/ file tsx compiled in memory, from Node's `source-map-cache` entry.
 * Line lengths stand in for the text: each line ends in one "\n". tsx
 * minifies whitespace, so no line opens with indentation to skip.
 */
const tsxScript = (
  lineLengths: readonly number[],
  map: z.infer<typeof SourceMapJson>,
): Omit<Script, "file" | "functions"> => {
  const lineStarts = [0];
  for (const length of lineLengths) {
    lineStarts.push((lineStarts.at(-1) ?? 0) + length + 1);
  }
  return { lineStarts, map, mapsCode: () => true };
};

/**
 * Covered src/ lines from one raw `NODE_V8_COVERAGE` report (one process).
 * Two kinds of script count:
 *
 * - under `<root>/dist/`: the built package, mapped back to src/ through its
 *   source maps (`<script>.map`). `read` returns a file's text, or undefined
 *   when it is missing.
 * - under `<root>/src/` with a `source-map-cache` entry: a file tsx compiled
 *   in memory, mapped back through the source map Node kept for it.
 */
export const linesFromV8 = (
  json: unknown,
  root: string,
  read: (file: string) => string | undefined,
): Lines => {
  const dist = path.join(root, "dist") + path.sep;
  const src = path.join(root, "src") + path.sep;
  const report = V8ReportWithCache.parse(json);
  const cache = report["source-map-cache"] ?? {};
  const lines: Lines = new Map();
  for (const { url, functions } of report.result) {
    const file = toPath(url);
    if (file.startsWith(dist)) {
      const text = read(file);
      const sourceMap = text === undefined ? undefined : read(`${file}.map`);
      if (text !== undefined && sourceMap !== undefined) {
        addScriptLines(
          lines,
          { file, functions, ...builtScript(text, sourceMap) },
          root,
        );
      }
    } else if (file.startsWith(src)) {
      const cached = cache[url];
      const map = cached?.data;
      if (cached !== undefined && map !== null && map !== undefined) {
        addScriptLines(
          lines,
          { file, functions, ...tsxScript(cached.lineLengths, map) },
          root,
        );
      }
    }
  }
  return lines;
};
