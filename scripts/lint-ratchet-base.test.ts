import { describe, expect, it } from "vitest";
import { missingBaseBaseline } from "./lint-ratchet-core.ts";

describe("missingBaseBaseline", () => {
  it("fails in CI, naming the baseline and the fetch that fixes it", () => {
    const failure = missingBaseBaseline("scripts/lint-baseline.json", "true");
    expect(failure).toContain("origin/main:scripts/lint-baseline.json");
    expect(failure).toContain(
      "git fetch --no-tags --depth=1 origin main:refs/remotes/origin/main",
    );
  });

  it("skips outside CI", () => {
    expect(
      missingBaseBaseline("scripts/lint-baseline.json", undefined),
    ).toBeUndefined();
    expect(
      missingBaseBaseline("scripts/lint-baseline.json", "false"),
    ).toBeUndefined();
  });
});
