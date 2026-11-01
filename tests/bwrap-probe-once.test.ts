import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import {
  NATIVE_PROVIDERS,
  assertUsable,
  skipsHere,
} from "./helpers/nativeProviders.js";

// bwrap() checks that Bubblewrap is usable once per process, not once per
// sandbox. Its own file: the outcome is remembered for the whole module.
// Gated like the containment suite: a missing bwrap fails when CI is set.

const BWRAP = NATIVE_PROVIDERS.find((p) => p.name === "bwrap()");
if (BWRAP === undefined) {
  throw new Error("NATIVE_PROVIDERS has no bwrap() entry");
}

describe.skipIf(skipsHere(BWRAP))("bwrap() construction check", () => {
  beforeAll(() => {
    assertUsable(BWRAP);
  });

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
