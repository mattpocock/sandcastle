import { describe, expect, it } from "vitest";
import { mirrorProblems } from "./check-skills-mirror-core.ts";

const tracker = "# Issue tracker: GitHub\n";

const codeReviewUpstream = {
  "SKILL.md":
    "Intro.\n\nThe issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.\n",
  "agents/openai.yaml": "interface: {}\n",
};

const codeReviewMirror = {
  "SKILL.md":
    "Intro.\n\nThe issue tracker is described in the tracker doc, [tracker.md](tracker.md).\n",
  "tracker.md": tracker,
};

describe("mirrorProblems", () => {
  it("passes a mirror that differs only as intended", () => {
    expect(
      mirrorProblems({
        skill: "code-review",
        mirror: codeReviewMirror,
        upstream: codeReviewUpstream,
        githubTrackerDoc: tracker,
      }),
    ).toStrictEqual([]);
  });

  it("reports a file that drifted from upstream", () => {
    expect(
      mirrorProblems({
        skill: "tdd",
        mirror: { "SKILL.md": "old\n" },
        upstream: { "SKILL.md": "new\n" },
        githubTrackerDoc: tracker,
      }),
    ).toStrictEqual(["tdd/SKILL.md differs from upstream at line 1"]);
  });

  it("reports an intended edit whose upstream text has gone", () => {
    expect(
      mirrorProblems({
        skill: "code-review",
        mirror: codeReviewMirror,
        upstream: { "SKILL.md": "Intro, reworded.\n" },
        githubTrackerDoc: tracker,
      }),
    ).toStrictEqual([
      "code-review/SKILL.md no longer contains the upstream text of an intended edit",
    ]);
  });

  it("reports upstream files the mirror lacks and mirror files upstream lacks", () => {
    expect(
      mirrorProblems({
        skill: "pr",
        mirror: { "SKILL.md": "x\n", "extra.md": "y\n" },
        upstream: { "SKILL.md": "x\n", "CREDITS.md": "z\n" },
        githubTrackerDoc: tracker,
      }),
    ).toStrictEqual([
      "pr/CREDITS.md is upstream but not mirrored",
      "pr/extra.md is mirrored but not upstream",
    ]);
  });

  it("reports a tracker doc that drifted from upstream's GitHub tracker doc", () => {
    expect(
      mirrorProblems({
        skill: "code-review",
        mirror: { ...codeReviewMirror, "tracker.md": "# Old\n" },
        upstream: codeReviewUpstream,
        githubTrackerDoc: tracker,
      }),
    ).toStrictEqual(["code-review/tracker.md differs from upstream at line 1"]);
  });
});
