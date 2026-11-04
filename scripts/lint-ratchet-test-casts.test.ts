import { describe, expect, it } from "vitest";
import { typeAssertionCount } from "./lint-ratchet-test-casts.ts";

const count = (source: string): number =>
  typeAssertionCount(source, "tests/a.test.ts");

describe("ratchet/test-type-assertion", () => {
  it.each([
    [`const x = value as Options;`],
    [`const x = value as unknown;`],
    [`const x = <Options>value;`],
    [`expect((result as { ok: boolean }).ok).toBe(true);`],
  ])("counts a type assertion: %s", (source) => {
    expect(count(source)).toBe(1);
  });

  it("counts each half of a double cast", () => {
    expect(count(`const x = value as unknown as Options;`)).toBe(2);
  });

  it.each([
    [`const modes = ["a", "b"] as const;`],
    [`const x = <const>["a"];`],
    [`// cast it as Options\nconst s = "as Options";`],
    [`const x = value satisfies Options;`],
    [`import { a as b } from "x";`],
  ])("does not count: %s", (source) => {
    expect(count(source)).toBe(0);
  });
});
