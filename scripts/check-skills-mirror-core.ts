// What scripts/check-skills-mirror.ts allows between the in-repo skills
// (src/v1/skills/) and their upstream copies, and the comparison itself.

/** An edit the mirror makes on purpose: `upstream` text replaced by `mirror`. */
export interface IntendedEdit {
  readonly file: string;
  readonly upstream: string;
  readonly mirror: string;
  readonly why: string;
}

/** Upstream files the mirror leaves out on purpose, relative to a skill's folder. */
export const OMITTED_FILES: readonly string[] = ["agents/openai.yaml"];

/** Where the `{ kind: "github" }` tracker doc comes from upstream. */
export const GITHUB_TRACKER_DOC =
  "skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md";

const TRACKER_DOC = "tracker.md";

/** Every intended edit, by skill. Anything else is drift. */
export const INTENDED_EDITS: Readonly<Record<string, readonly IntendedEdit[]>> =
  {
    implement: [
      {
        file: "SKILL.md",
        upstream: "fetch it from the issue tracker and state its title",
        mirror:
          "fetch it from the issue tracker described in [tracker.md](tracker.md) and state its title",
        why: "point at the tracker doc rendered beside the skill",
      },
    ],
    "code-review": [
      {
        file: "SKILL.md",
        upstream:
          "The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.",
        mirror:
          "The issue tracker is described in the tracker doc, [tracker.md](tracker.md).",
        why: "the tracker is always rendered in, so there is no setup to run",
      },
    ],
  };

/** The skills that get a `tracker.md`, rendered from the run's tracker. */
const WITH_TRACKER_DOC = new Set(["implement", "code-review"]);

const firstDifferentLine = (a: string, b: string): number => {
  const left = a.split("\n");
  const right = b.split("\n");
  const index = left.findIndex((line, i) => line !== right[i]);
  return (index === -1 ? left.length : index) + 1;
};

const applyEdits = (
  skill: string,
  file: string,
  text: string,
): string | undefined => {
  let result: string | undefined = text;
  for (const edit of INTENDED_EDITS[skill] ?? []) {
    if (edit.file === file && result !== undefined) {
      result = result.includes(edit.upstream)
        ? result.replace(edit.upstream, edit.mirror)
        : undefined;
    }
  }
  return result;
};

/** The expected mirror of a skill: upstream with the intended edits made. */
const expectedMirror = (input: {
  readonly skill: string;
  readonly upstream: Readonly<Record<string, string>>;
  readonly githubTrackerDoc: string;
}): Map<string, string | undefined> => {
  const expected = new Map<string, string | undefined>();
  for (const [file, text] of Object.entries(input.upstream)) {
    if (!OMITTED_FILES.includes(file)) {
      expected.set(file, applyEdits(input.skill, file, text));
    }
  }
  if (WITH_TRACKER_DOC.has(input.skill)) {
    expected.set(TRACKER_DOC, input.githubTrackerDoc);
  }
  return expected;
};

/**
 * Every unintended difference between a skill as mirrored (rendered for a
 * GitHub tracker) and its upstream folder. Empty when the mirror is faithful.
 */
export const mirrorProblems = (input: {
  readonly skill: string;
  readonly mirror: Readonly<Record<string, string>>;
  readonly upstream: Readonly<Record<string, string>>;
  readonly githubTrackerDoc: string;
}): string[] => {
  const { skill, mirror } = input;
  const problems: string[] = [];
  const expected = expectedMirror(input);
  for (const [file, text] of expected) {
    const actual = mirror[file];
    if (actual === undefined) {
      problems.push(`${skill}/${file} is upstream but not mirrored`);
    } else if (text === undefined) {
      problems.push(
        `${skill}/${file} no longer contains the upstream text of an intended edit`,
      );
    } else if (actual !== text) {
      problems.push(
        `${skill}/${file} differs from upstream at line ${firstDifferentLine(actual, text)}`,
      );
    }
  }
  for (const file of Object.keys(mirror)) {
    if (!expected.has(file)) {
      problems.push(`${skill}/${file} is mirrored but not upstream`);
    }
  }
  return problems;
};
