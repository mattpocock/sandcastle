// Raw V8 coverage (NODE_V8_COVERAGE) from a process running the built
// package, mapped back to src/ lines through dist's source maps. Used by
// scripts/coverage-gate.ts to count the CLI subprocesses e2e tests spawn.

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

/** Every mapping in `mappings`, located by offset into `script`. */
const decodeMappings = (script: string, mappings: string): Mapping[] => {
  const lineStarts = [0];
  for (let i = 0; i < script.length; i++) {
    if (script[i] === "\n") {
      lineStarts.push(i + 1);
    }
  }
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
  /** Absolute path of the built script. */
  readonly file: string;
  readonly text: string;
  readonly sourceMap: string;
  readonly functions: Ranges;
}

/** Adds the src/ lines one built script ran to `lines`. */
const addScriptLines = (lines: Lines, script: Script, root: string): void => {
  const map = SourceMapJson.parse(JSON.parse(script.sourceMap));
  const sources = map.sources.map((source) =>
    path
      .relative(
        root,
        path.resolve(path.dirname(script.file), map.sourceRoot ?? "", source),
      )
      .replaceAll("\\", "/"),
  );
  const counts = countsByOffset(script.text.length, script.functions);
  for (const { offset, source, line } of decodeMappings(
    script.text,
    map.mappings,
  )) {
    const file = sources[source];
    // A mapping on whitespace (a line's indentation) carries on the source
    // line above, and would count it from the next line's block.
    if (
      file?.startsWith("src/") === true &&
      /\S/u.test(script.text[offset] ?? "") &&
      (counts[offset] ?? 0) > 0
    ) {
      lines.set(file, (lines.get(file) ?? new Set()).add(line));
    }
  }
};

/**
 * Covered src/ lines from one raw `NODE_V8_COVERAGE` report (one process).
 * Only scripts under `<root>/dist/` count: the built package, mapped back to
 * src/ through its source maps (`<script>.map`). `read` returns a file's
 * text, or undefined when it is missing.
 */
export const linesFromV8 = (
  json: unknown,
  root: string,
  read: (file: string) => string | undefined,
): Lines => {
  const dist = path.join(root, "dist") + path.sep;
  const lines: Lines = new Map();
  for (const { url, functions } of V8Report.parse(json).result) {
    const file = url.startsWith("file:") ? fileURLToPath(url) : url;
    const text = file.startsWith(dist) ? read(file) : undefined;
    const sourceMap = text === undefined ? undefined : read(`${file}.map`);
    if (text !== undefined && sourceMap !== undefined) {
      addScriptLines(lines, { file, text, sourceMap, functions }, root);
    }
  }
  return lines;
};
