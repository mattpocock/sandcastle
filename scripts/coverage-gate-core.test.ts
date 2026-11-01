import { describe, expect, it } from "vitest";
import { linesFromIstanbul, merge, report } from "./coverage-gate-core.ts";
import { linesFromV8 } from "./coverage-gate-v8.ts";

const ROOT = "/repo";

/** An istanbul coverage-final.json entry: statement id -> [line, hits]. */
const istanbul = (
  file: string,
  statements: readonly (readonly [number, number])[],
): Record<string, unknown> => ({
  [file]: {
    statementMap: Object.fromEntries(
      statements.map(([line], id) => [String(id), { start: { line } }]),
    ),
    s: Object.fromEntries(statements.map(([, hits], id) => [String(id), hits])),
  },
});

describe("linesFromIstanbul", () => {
  it("keeps the start lines of statements that ran, keyed by repo path", () => {
    expect(
      linesFromIstanbul(
        istanbul("/repo/src/a.ts", [
          [3, 1],
          [4, 0],
          [7, 2],
        ]),
        ROOT,
      ),
    ).toStrictEqual(new Map([["src/a.ts", new Set([3, 7])]]));
  });

  it("maps a Windows CI checkout's paths onto this repo", () => {
    expect(
      linesFromIstanbul(
        istanbul(String.raw`D:\a\sandcastle\sandcastle\src\mountUtils.ts`, [
          [242, 1],
        ]),
        ROOT,
      ),
    ).toStrictEqual(new Map([["src/mountUtils.ts", new Set([242])]]));
  });
});

describe("merge", () => {
  it("counts a line covered by any source", () => {
    const linux = linesFromIstanbul(
      istanbul("/repo/src/mountUtils.ts", [
        [10, 1],
        [242, 0],
      ]),
      ROOT,
    );
    const windows = linesFromIstanbul(
      istanbul(String.raw`D:\a\sandcastle\sandcastle\src\mountUtils.ts`, [
        [10, 0],
        [242, 3],
      ]),
      ROOT,
    );
    expect(merge(linux, windows)).toStrictEqual(
      new Map([["src/mountUtils.ts", new Set([10, 242])]]),
    );
  });
});

// A real build and a real NODE_V8_COVERAGE report: esbuild compiled
// src/a.ts below to dist/a.js, and `node dist/a.js` wrote the report.
// pick(true) never reaches `return "no"` (src line 5).
const SRC_A = [
  "export const pick = (flag: boolean): string => {",
  "  if (flag) {",
  '    return "yes";',
  "  }",
  '  return "no";',
  "};",
  "pick(true);",
  "",
].join("\n");
const DIST_A = [
  "const pick = (flag) => {",
  "  if (flag) {",
  '    return "yes";',
  "  }",
  '  return "no";',
  "};",
  "pick(true);",
  "export {",
  "  pick",
  "};",
  "//# sourceMappingURL=a.js.map",
  "",
].join("\n");
const DIST_A_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/a.ts"],
  sourcesContent: [SRC_A],
  mappings:
    "AAAO,MAAM,OAAO,CAAC,SAA0B;AAC7C,MAAI,MAAM;AACR,WAAO;AAAA,EACT;AACA,SAAO;AACT;AACA,KAAK,IAAI;",
  names: [],
});
const v8Report = (url: string) => ({
  result: [
    {
      scriptId: "88",
      url,
      functions: [
        {
          functionName: "",
          ranges: [{ startOffset: 0, endOffset: 140, count: 1 }],
          isBlockCoverage: true,
        },
        {
          functionName: "pick",
          ranges: [
            { startOffset: 13, endOffset: 77, count: 1 },
            { startOffset: 60, endOffset: 76, count: 0 },
          ],
          isBlockCoverage: true,
        },
      ],
    },
  ],
});
const files: Record<string, string> = {
  "/repo/dist/a.js": DIST_A,
  "/repo/dist/a.js.map": DIST_A_MAP,
};
const read = (file: string): string | undefined => files[file];

describe("linesFromV8", () => {
  it("maps a built script's executed ranges back to src lines", () => {
    expect(
      linesFromV8(v8Report("file:///repo/dist/a.js"), ROOT, read),
    ).toStrictEqual(new Map([["src/a.ts", new Set([1, 2, 3, 4, 6, 7])]]));
  });

  it("keeps columns right past segments that map to no source", () => {
    // "K" moves to column 5 and maps nowhere; "EACA" is column 7, src line 2.
    const script = "a(); b(); c();\n";
    const map = JSON.stringify({
      version: 3,
      sources: ["../src/b.ts"],
      mappings: "AAAA,K,EACA",
    });
    const coverage = {
      result: [
        {
          url: "file:///repo/dist/b.js",
          functions: [
            {
              ranges: [
                { startOffset: 0, endOffset: 15, count: 1 },
                { startOffset: 6, endOffset: 15, count: 0 },
              ],
            },
          ],
        },
      ],
    };
    const own: Record<string, string> = {
      "/repo/dist/b.js": script,
      "/repo/dist/b.js.map": map,
    };
    expect(linesFromV8(coverage, ROOT, (f) => own[f])).toStrictEqual(
      new Map([["src/b.ts", new Set([1])]]),
    );
  });

  it("ignores a mapping on indentation, which carries the line above", () => {
    // Line 2 of the script opens with a column-0 mapping back to src line 2
    // (`b()`, which never ran); the indentation it points at ran anyway.
    const script = "a();b();\n  c();\n";
    const map = JSON.stringify({
      version: 3,
      sources: ["../src/c.ts"],
      mappings: "AAAA,IACA;AAAA,EACA",
    });
    const coverage = {
      result: [
        {
          url: "file:///repo/dist/c.js",
          functions: [
            {
              ranges: [
                { startOffset: 0, endOffset: 16, count: 1 },
                { startOffset: 4, endOffset: 8, count: 0 },
              ],
            },
          ],
        },
      ],
    };
    const own: Record<string, string> = {
      "/repo/dist/c.js": script,
      "/repo/dist/c.js.map": map,
    };
    expect(linesFromV8(coverage, ROOT, (f) => own[f])).toStrictEqual(
      new Map([["src/c.ts", new Set([1, 3])]]),
    );
  });

  it("ignores bundled dependencies' own src/ folders", () => {
    const bundled: Record<string, string> = {
      ...files,
      "/repo/dist/a.js.map": DIST_A_MAP.replace(
        "../src/a.ts",
        "../node_modules/effect/src/a.ts",
      ),
    };
    expect(
      linesFromV8(v8Report("file:///repo/dist/a.js"), ROOT, (f) => bundled[f]),
    ).toStrictEqual(new Map());
  });

  it("ignores scripts outside dist/", () => {
    expect(
      linesFromV8(v8Report("file:///repo/node_modules/x/a.js"), ROOT, read),
    ).toStrictEqual(new Map());
  });

  // A real NODE_V8_COVERAGE report from `tsx src/a.ts` (SRC_A above). tsx
  // compiles in memory, so the report's source-map-cache carries the map
  // and line lengths; there is no file to read.
  const tsxReport = (cache: boolean) => ({
    result: [
      {
        url: "file:///repo/src/a.ts",
        functions: [
          { ranges: [{ startOffset: 0, endOffset: 696, count: 1 }] },
          { ranges: [{ startOffset: 47, endOffset: 113, count: 1 }] },
          {
            ranges: [
              { startOffset: 132, endOffset: 171, count: 1 },
              { startOffset: 160, endOffset: 170, count: 0 },
            ],
          },
        ],
      },
    ],
    ...(cache && {
      "source-map-cache": {
        "file:///repo/src/a.ts": {
          url: "file:///repo/src/a.ts",
          lineLengths: [204, 0, 490],
          data: {
            version: 3,
            sources: ["file:///repo/src/a.ts"],
            sourcesContent: [SRC_A],
            names: [],
            mappings:
              "kHAAO,MAAM,KAAO,OAAC,MAA0B,CAC7C,GAAI,KAAM,CACR,MAAO,KACT,CACA,MAAO,IACT,EALoB,QAMpB,KAAK,IAAI",
          },
        },
      },
    }),
  });
  const noFiles = (): undefined => undefined;

  it("maps a src/ file run through tsx back to its lines", () => {
    expect(linesFromV8(tsxReport(true), ROOT, noFiles)).toStrictEqual(
      new Map([["src/a.ts", new Set([1, 2, 3, 4, 6, 7])]]),
    );
  });

  it("ignores a src/ script with no source map in the report", () => {
    expect(linesFromV8(tsxReport(false), ROOT, noFiles)).toStrictEqual(
      new Map(),
    );
  });
});

describe("report", () => {
  const only = new Map([["src/a.ts", new Set([1, 2, 3])]]);

  it("names every coverage source it counted", () => {
    const text = report({
      file: "src/a.test.ts",
      only,
      e2e: new Map([["src/a.ts", new Set([1, 2, 3])]]),
      sources: ["e2e tests in vitest (this machine)", "windows CI job: cov/"],
    });
    expect(text).toContain(
      [
        "Coverage counted as end to end:",
        "",
        "- e2e tests in vitest (this machine)",
        "- windows CI job: cov/",
      ].join("\n"),
    );
  });

  it("fails, listing the lines no source covers", () => {
    const text = report({
      file: "src/a.test.ts",
      only,
      e2e: new Map([["src/a.ts", new Set([2])]]),
      sources: [],
    });
    expect(text).toContain("**Gate: fail.** 2 of the 3 lines");
    expect(text).toContain("| `src/a.ts` | 2 | 1, 3 |");
  });
});
