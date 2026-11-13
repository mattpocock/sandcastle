import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("update-branch prompt", () => {
  it("requests only PR fields available to the workflow token", () => {
    const prompt = readFileSync(new URL("prompt.md", import.meta.url), "utf8");

    expect(prompt).toContain(
      "gh pr view {{PR_NUMBER}} --json number,title,body,state,baseRefName,headRefName,url",
    );
  });
});
