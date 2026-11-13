import { describe, expect, it } from "vitest";
import { missingBaseBaseline } from "./lint-ratchet-baseline.ts";

describe("missingBaseBaseline", () => {
  it("fails in CI, naming the baseline and the checkout that fixes it", () => {
    const failure = missingBaseBaseline("scripts/lint-baseline.json", "true");
    expect(failure).toContain("origin/main:scripts/lint-baseline.json");
    expect(failure).toContain("fetch-depth: 0");
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
