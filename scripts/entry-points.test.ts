import { describe, expect, it } from "vitest";
import type { EntryPointLists } from "./entry-points.ts";
import { checkEntryPoints, readEntryPointLists } from "./entry-points.ts";

const agreeing: EntryPointLists = {
  exports: {
    ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
    "./sandboxes/docker": {
      import: "./dist/sandboxes/docker.js",
      types: "./dist/sandboxes/docker.d.ts",
    },
  },
  bin: { sandcastle: "dist/main.js" },
  tsupEntries: {
    index: "src/index.ts",
    main: "src/main.ts",
    "sandboxes/docker": "src/sandboxes/docker.ts",
  },
  cruiserEntryPoints: "^src/(index|sandboxes/(docker))[.]ts$",
  srcFiles: [
    "src/index.ts",
    "src/main.ts",
    "src/sandboxes/docker.ts",
    "src/sandboxes/vercel.ts",
  ],
};

describe("checkEntryPoints", () => {
  it("passes when exports, tsup entries and the dependency-cruiser entry points agree", () => {
    expect(checkEntryPoints(agreeing)).toStrictEqual([]);
  });

  it("fails when an export has no tsup entry", () => {
    expect(
      checkEntryPoints({
        ...agreeing,
        tsupEntries: { index: "src/index.ts", main: "src/main.ts" },
      }),
    ).toStrictEqual([
      'package.json exports "./sandboxes/docker" has no tsup.config.ts entry "sandboxes/docker"',
    ]);
  });

  it("fails when the dependency-cruiser entry points miss an export", () => {
    expect(
      checkEntryPoints({
        ...agreeing,
        cruiserEntryPoints: "^src/(index)[.]ts$",
      }),
    ).toStrictEqual([
      'package.json exports "./sandboxes/docker" (src/sandboxes/docker.ts) is not in the .dependency-cruiser.mjs ENTRY_POINTS',
    ]);
  });

  it("fails when the dependency-cruiser entry points name a file that is not exported", () => {
    expect(
      checkEntryPoints({
        ...agreeing,
        cruiserEntryPoints: "^src/(index|sandboxes/(docker|vercel))[.]ts$",
      }),
    ).toStrictEqual([
      ".dependency-cruiser.mjs ENTRY_POINTS matches src/sandboxes/vercel.ts, which no package.json export points at",
    ]);
  });

  it("fails when a tsup entry is neither an export nor a bin", () => {
    expect(
      checkEntryPoints({
        ...agreeing,
        tsupEntries: {
          ...agreeing.tsupEntries,
          "sandboxes/vercel": "src/sandboxes/vercel.ts",
        },
      }),
    ).toStrictEqual([
      'tsup.config.ts entry "sandboxes/vercel" is neither a package.json export nor a bin',
    ]);
  });

  it("fails when an export points at the wrong built files", () => {
    expect(
      checkEntryPoints({
        ...agreeing,
        exports: {
          ...agreeing.exports,
          "./sandboxes/docker": {
            import: "./dist/sandboxes/dockr.js",
            types: "./dist/sandboxes/docker.d.ts",
          },
        },
      }),
    ).toStrictEqual([
      'package.json exports "./sandboxes/docker" import is ./dist/sandboxes/dockr.js, expected ./dist/sandboxes/docker.js',
    ]);
  });

  it("fails when a tsup entry builds from a different source file", () => {
    expect(
      checkEntryPoints({
        ...agreeing,
        tsupEntries: {
          ...agreeing.tsupEntries,
          "sandboxes/docker": "src/sandboxes/podman.ts",
        },
      }),
    ).toStrictEqual([
      'tsup.config.ts entry "sandboxes/docker" is src/sandboxes/podman.ts, expected src/sandboxes/docker.ts',
    ]);
  });
});

describe("this repo", () => {
  it("lists the same entry points in package.json, tsup.config.ts and .dependency-cruiser.mjs", async () => {
    expect(checkEntryPoints(await readEntryPointLists())).toStrictEqual([]);
  });
});
