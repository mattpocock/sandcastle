import { describe, expect, it } from "vitest";
import { beadsVersionWarning, parseBdVersion } from "./InitService.js";

describe("parseBdVersion", () => {
  it("reads the version from `bd version` output", () => {
    expect(
      parseBdVersion("bd version 1.0.0 (72170267: HEAD@72170267e00a)\n"),
    ).toBe("1.0.0");
  });

  it("finds the version line after bd's first-run notice", () => {
    expect(
      parseBdVersion("Thanks for using bd! …\nbd version 1.3.2 (abc)\n"),
    ).toBe("1.3.2");
  });

  it("returns undefined for output with no version", () => {
    expect(parseBdVersion("command not found")).toBeUndefined();
  });
});

describe("beadsVersionWarning", () => {
  it("says nothing when the host runs the image's bd", () => {
    expect(beadsVersionWarning("1.3.2")).toBeUndefined();
  });

  it("warns that an older host bd will lose writes, and to upgrade it", () => {
    const warning = beadsVersionWarning("1.0.0");
    expect(warning).toContain("bd 1.0.0");
    expect(warning).toContain("can no longer create issues");
    expect(warning).toContain("Upgrade the host's bd to 1.3.2");
  });

  it("compares versions numerically, not as strings", () => {
    expect(beadsVersionWarning("1.10.0")).toContain(
      "Set ARG BEADS_VERSION in the Dockerfile to 1.10.0",
    );
  });

  it("warns when bd isn't on the host", () => {
    expect(beadsVersionWarning()).toContain("bd isn't on your PATH");
  });
});
