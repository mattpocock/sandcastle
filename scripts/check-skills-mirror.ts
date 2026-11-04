// Checks the in-repo skills (src/v1/skills/) against the public skills repo
// they're mirrored from, at the recorded commit and at `main`. Each skill is
// rendered for Claude Code and a GitHub tracker and compared file by file
// with its upstream folder; only the differences listed in
// scripts/check-skills-mirror-core.ts are allowed. Run by hand (not in CI):
// it needs the network and an authenticated `gh`.
//
//   npm run skills:check-mirror
//
// Exits 1 when a skill drifted at the recorded commit. Drift at `main` only
// means upstream moved on: copy the skills again and bump UPSTREAM_COMMIT.

import { MIRRORED_SKILLS } from "../src/v1/skills/mirroredSkills.ts";
import type { Skill } from "../src/v1/skills/Skill.ts";
import { UPSTREAM_COMMIT, UPSTREAM_REPO } from "../src/v1/skills/Skill.ts";
import {
  GITHUB_TRACKER_DOC,
  INTENDED_EDITS,
  OMITTED_FILES,
  mirrorProblems,
} from "./check-skills-mirror-core.ts";
import { run } from "./lint-ratchet-sources.ts";

const gh = async (endpoint: string, accept: string): Promise<string> =>
  run("gh", ["api", "-H", `Accept: ${accept}`, endpoint]);

const rawFile = async (file: string, ref: string): Promise<string> =>
  gh(
    `repos/${UPSTREAM_REPO}/contents/${file}?ref=${ref}`,
    "application/vnd.github.raw",
  );

/** Every file path in the upstream repo at `ref`. */
const filesAt = async (ref: string): Promise<string[]> => {
  const tree: unknown = JSON.parse(
    await gh(
      `repos/${UPSTREAM_REPO}/git/trees/${ref}?recursive=1`,
      "application/vnd.github+json",
    ),
  );
  const entries =
    typeof tree === "object" && tree !== null && "tree" in tree
      ? tree.tree
      : [];
  return (Array.isArray(entries) ? entries : []).flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    "type" in entry &&
    entry.type === "blob" &&
    "path" in entry &&
    typeof entry.path === "string"
      ? [entry.path]
      : [],
  );
};

const upstreamFolder = async (
  skill: Skill,
  ref: string,
  paths: readonly string[],
): Promise<Record<string, string>> => {
  const prefix = `${skill.upstream.path}/`;
  const inside = paths.filter((file) => file.startsWith(prefix));
  const texts = await Promise.all(
    inside.map(async (file) => rawFile(file, ref)),
  );
  return Object.fromEntries(
    inside.map((file, i) => [file.slice(prefix.length), texts[i] ?? ""]),
  );
};

const checkAt = async (ref: string): Promise<string[]> => {
  const paths = await filesAt(ref);
  const githubTrackerDoc = await rawFile(GITHUB_TRACKER_DOC, ref);
  const results = await Promise.all(
    Object.values(MIRRORED_SKILLS).map(async (skill) =>
      mirrorProblems({
        skill: skill.name,
        mirror: skill.files({
          agent: "claudeCode",
          tracker: { kind: "github" },
        }),
        upstream: await upstreamFolder(skill, ref, paths),
        githubTrackerDoc,
      }),
    ),
  );
  return results.flat();
};

const printIntended = (): void => {
  console.log(`Intended differences from ${UPSTREAM_REPO}:`);
  for (const [skill, edits] of Object.entries(INTENDED_EDITS)) {
    for (const edit of edits) {
      console.log(`  ${skill}/${edit.file}: ${edit.why}`);
    }
  }
  console.log(
    `  implement, code-review: add tracker.md (${GITHUB_TRACKER_DOC} for a GitHub tracker)`,
  );
  console.log(`  every skill: leave out ${OMITTED_FILES.join(", ")}`);
};

const report = (label: string, problems: readonly string[]): void => {
  console.log(
    problems.length === 0
      ? `\n${label}: only the intended differences.`
      : `\n${label}: ${problems.length} unintended difference(s):`,
  );
  for (const problem of problems) {
    console.log(`  ${problem}`);
  }
};

const main = async (): Promise<void> => {
  printIntended();
  const [pinned, latest] = await Promise.all([
    checkAt(UPSTREAM_COMMIT),
    checkAt("main"),
  ]);
  report(`Recorded commit ${UPSTREAM_COMMIT.slice(0, 7)}`, pinned);
  report("main", latest);
  if (pinned.length > 0) {
    process.exitCode = 1;
  }
};

await main();
