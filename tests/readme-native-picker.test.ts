import { readFileSync } from "node:fs";
import path from "node:path";
import { NativeSandboxUnavailableError } from "@ai-hero/sandcastle";
import type { BindMountSandboxProvider } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import { seatbelt } from "@ai-hero/sandcastle/sandboxes/seatbelt";
import { describe, expect, it } from "vitest";
import { NATIVE_PROVIDERS, skipsHere } from "./helpers/nativeProviders.js";

/**
 * The README's one-line `process.platform` picker for the native sandbox,
 * verbatim. `pickSandbox` below holds the same line, so it typechecks against
 * the public API; the first test keeps the README and this file in step.
 */
const README_PICKER =
  'const sandbox = process.platform === "darwin" ? seatbelt() : bwrap();';

const pickSandbox = (): BindMountSandboxProvider => {
  const sandbox = process.platform === "darwin" ? seatbelt() : bwrap();
  return sandbox;
};

const thisFile = import.meta.filename;
const readme = path.resolve(import.meta.dirname, "..", "README.md");

describe("README: picking the native sandbox with process.platform", () => {
  it("is the same line in the README and in this typechecked file", () => {
    expect(readFileSync(readme, "utf8")).toContain(README_PICKER);
    expect(readFileSync(thisFile, "utf8")).toContain(
      README_PICKER.replace("const sandbox = ", "  const sandbox = "),
    );
  });

  describe.each(NATIVE_PROVIDERS)("on $platform", (provider) => {
    it.skipIf(skipsHere(provider))(`picks ${provider.name}`, () => {
      expect(`${pickSandbox().name}()`).toBe(provider.name);
    });
  });

  it.runIf(process.platform === "win32")(
    "throws NativeSandboxUnavailableError on Windows, pointing to WSL2",
    () => {
      expect(pickSandbox).toThrow(NativeSandboxUnavailableError);
      expect(pickSandbox).toThrow(/WSL2/u);
    },
  );
});
