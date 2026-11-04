// A temporary seam. The in-repo skills are internal, so tests/ can't reach
// them yet: this tooling test imports them directly. Once bundled tasks test
// skills through the public `/tasks` entry point, e2e tests there replace the
// rendering and install tests here.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox } from "../src/v1/createSandbox.ts";
import { installSkills } from "../src/v1/skills/installSkills.ts";
import { MIRRORED_SKILLS } from "../src/v1/skills/mirroredSkills.ts";
import type { SkillsContext } from "../src/v1/skills/Skill.ts";
import { fakeSandbox } from "../src/v1/testing.ts";

const { implement, tdd, codeReview } = MIRRORED_SKILLS;
const skills = Object.values(MIRRORED_SKILLS);

const github: SkillsContext = {
  agent: "claudeCode",
  tracker: { kind: "github" },
};

const linear: SkillsContext = {
  agent: "claudeCode",
  tracker: {
    kind: "custom",
    name: "Linear",
    instructions: "Read a ticket with `linear issue view <id>`.",
  },
};

describe("rendering the in-repo skills", () => {
  it("records the upstream commit on every skill", () => {
    expect(
      skills.map((skill) => [skill.name, skill.upstream.commit]),
    ).toStrictEqual([
      ["implement", "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d"],
      ["tdd", "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d"],
      ["codebase-design", "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d"],
      ["code-review", "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d"],
      ["pr", "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d"],
    ]);
  });

  it("renders each skill's files", () => {
    expect(
      skills.map((skill) => [skill.name, Object.keys(skill.files(github))]),
    ).toStrictEqual([
      ["implement", ["SKILL.md", "tracker.md"]],
      ["tdd", ["SKILL.md", "tests.md", "mocking.md"]],
      ["codebase-design", ["SKILL.md", "DEEPENING.md", "DESIGN-IT-TWICE.md"]],
      ["code-review", ["SKILL.md", "tracker.md"]],
      ["pr", ["SKILL.md", "CREDITS.md"]],
    ]);
  });

  it("keeps implement a slash command only", () => {
    expect(implement.files(github)["SKILL.md"]).toContain(
      "\ndisable-model-invocation: true\n",
    );
  });

  it("renders the GitHub tracker doc for a github tracker", () => {
    const doc = codeReview.files(github)["tracker.md"];
    expect(doc?.split("\n")[0]).toBe("# Issue tracker: GitHub");
    expect(doc).toContain("gh issue view <number>");
  });

  it("renders a custom tracker from its name and instructions", () => {
    expect(implement.files(linear)["tracker.md"]).toBe(
      "# Issue tracker: Linear\n\nRead a ticket with `linear issue view <id>`.",
    );
  });

  it("points the skills that fetch tickets at the tracker doc", () => {
    expect(implement.files(github)["SKILL.md"]).toContain(
      "fetch it from the issue tracker described in [tracker.md](tracker.md)",
    );
    expect(codeReview.files(github)["SKILL.md"]).toContain(
      "The issue tracker is described in the tracker doc, [tracker.md](tracker.md).",
    );
    expect(codeReview.files(github)["SKILL.md"]).not.toContain(
      "setup-matt-pocock-skills",
    );
  });

  it("changes only the tracker doc between trackers", () => {
    for (const skill of skills) {
      const { "tracker.md": githubDoc, ...githubRest } = skill.files(github);
      const { "tracker.md": linearDoc, ...linearRest } = skill.files(linear);
      expect(linearRest).toStrictEqual(githubRest);
      expect(linearDoc === githubDoc).toBe(githubDoc === undefined);
    }
  });
});

describe("installSkills", () => {
  const provider = fakeSandbox();
  afterEach(async () => provider.closeAll());

  it("writes every rendered file into the sandbox's ~/.claude/skills", async () => {
    await using sandbox = await createSandbox({ provider });
    await Effect.runPromise(installSkills(sandbox, [implement, tdd], linear));
    const home = path.join(provider.pathOf(sandbox.sandboxId), "home");
    const read = async (file: string) =>
      readFile(path.join(home, ".claude", "skills", file), "utf8");
    await expect(read("implement/tracker.md")).resolves.toBe(
      "# Issue tracker: Linear\n\nRead a ticket with `linear issue view <id>`.",
    );
    await expect(read("tdd/mocking.md")).resolves.toBe(
      tdd.files(linear)["mocking.md"],
    );
    await expect(read("implement/SKILL.md")).resolves.toContain(
      "\nname: implement\n",
    );
  });
});
