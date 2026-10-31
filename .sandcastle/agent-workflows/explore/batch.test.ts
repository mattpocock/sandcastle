import { describe, expect, it } from "vitest";
import { planEffects, TAGS } from "./batch";
import type { Plan, Tag } from "./batch";

const planFor = (tag: Tag): Plan => ({
  issues: [{ number: 1, tag, duplicate_of: null, comment: "Findings." }],
  patterns: "",
});

const labelFor = (tag: Tag): string | undefined =>
  planEffects(planFor(tag)).flatMap((effect) =>
    effect.kind === "swap-label" ? [effect.to] : [],
  )[0];

const footerFor = (tag: Tag): string | undefined =>
  planEffects(planFor(tag)).flatMap((effect) =>
    effect.kind === "comment" ? [effect.body] : [],
  )[0];

const EXPECTED: Record<Tag, string> = {
  "easy-call": "agent:implement",
  "needs-a-human": "ready-for-human",
  blocked: "agent:blocked",
};

describe("planEffects verdict labels", () => {
  it.each(TAGS)("swaps a %s survivor to its verdict's label", (tag) => {
    expect(labelFor(tag)).toBe(EXPECTED[tag]);
  });

  it.each(TAGS)("names the %s verdict's label in the comment footer", (tag) => {
    expect(footerFor(tag)).toContain(`\`${EXPECTED[tag]}\``);
  });
});
