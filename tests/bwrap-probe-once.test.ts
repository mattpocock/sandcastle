import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";

// bwrap() checks that Bubblewrap is usable once per process, not once per
// sandbox. Its own file: the outcome is remembered for the whole module.

const bwrapWorks =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0;

describe.skipIf(!bwrapWorks)("bwrap() construction check", () => {
  it("runs once per process: a later bwrap() doesn't look for Bubblewrap again", () => {
    bwrap();
    const emptyDir = mkdtempSync(path.join(tmpdir(), "e2e-bwrap-empty-path-"));
    const originalPath = process.env["PATH"];
    process.env["PATH"] = emptyDir;
    try {
      expect(() => bwrap()).not.toThrow();
    } finally {
      process.env["PATH"] = originalPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
