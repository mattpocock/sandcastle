import type { PreparedMerge } from "./taskMergePrepare.js";

// The `merge` task's own prompt: where the merge stands, how to finish it,
// the checks, the push and the result. It never names the default branch:
// `start` has already refused it.

/** What the prompt is written from. */
export interface MergePromptInput {
  readonly merge: PreparedMerge;
  readonly into: string;
  /** The caller's setup commands, already run in the clone. */
  readonly setup: readonly string[];
}

const fence = (text: string): string => `\`${text}\``;

const attemptBlock = (input: MergePromptInput): string => {
  const { merge, into } = input;
  const { attempt } = merge;
  switch (attempt.kind) {
    case "merged": {
      return `Sandcastle has already merged it, with no conflicts, in the merge commit ${fence(attempt.commit)}. Check it and push it.`;
    }
    case "up-to-date": {
      return `${fence(into)} already contains ${merge.source}, so there's nothing to merge and nothing to push. Report \`merged\`, with \`commit\` set to ${fence(into)}'s tip.`;
    }
    case "conflicted": {
      return [
        `Merging it conflicts in: ${attempt.files.map((file) => fence(file)).join(", ")}. Sandcastle aborted that try, so ${fence(into)} is clean. Redo the merge with \`git merge --no-ff -m ${JSON.stringify(merge.message)} ${merge.ref}\`.`,
        "Resolve every conflict keeping both sides' intent: read what each side's commits set out to do, and write a result that does both. Never resolve a conflict by dropping one side's change, and never pick a side wholesale with `--ours` or `--theirs`. Then commit the merge. If you can't resolve a conflict without losing one side's intent, run `git merge --abort` and report `conflict-unresolved`, naming the files and why.",
      ].join("\n\n");
    }
  }
};

const setupLine = (setup: readonly string[]): string =>
  setup.length === 0
    ? ""
    : ` These setup commands already ran in the clone: ${setup.map((command) => fence(command)).join(", ")}. Run them again after the merge if it changed what they install.`;

const checksBlock = (setup: readonly string[]): string =>
  `Before you push, run the repository's checks on the merged code: find them in its docs (README, CONTRIBUTING, CLAUDE.md, AGENTS.md) and its scripts (\`package.json\`, a Makefile, CI config).${setupLine(setup)} If a check fails because of how the two sides combine, fix it in the merge commit (\`git commit --amend\` before you push). If it still fails, or it fails on code the merge didn't touch, don't push: report \`checks-failed\` with the failing checks.`;

const rulesBlock = (into: string): string =>
  [
    "Rules:",
    `- Push only ${fence(into)}, with \`git push origin ${into}\`. Never force-push, and never rewrite a commit that's already on \`origin\`. If the push is rejected because ${fence(into)} moved, fetch, merge \`origin/${into}\` in, re-run the checks and push again.`,
    "- Never push, merge into or delete any other branch, and never open, approve, close or merge a pull request.",
  ].join("\n");

const RESULT = [
  "End with your result in the `mergeResult` tag, as JSON:",
  '`{ "status": "merged" | "conflict-unresolved" | "checks-failed" | "blocked", "into": string, "commit"?: string, "summary": string }`.',
  "Use `merged` once the merge is pushed (or there was nothing to merge), with `commit` set to the branch's new tip on `origin`; `conflict-unresolved` or `checks-failed` as above; and `blocked` when you couldn't go on for any other reason, with it in `summary`. Push nothing unless it's `merged`.",
].join("\n");

/** The task's prompt, before the parts every bundled task adds. */
export const mergePrompt = (input: MergePromptInput): string =>
  [
    `Merge ${input.merge.source} into ${fence(input.into)} with a merge commit, and push ${fence(input.into)}. The clone is on ${fence(input.into)}.`,
    attemptBlock(input),
    checksBlock(input.setup),
    rulesBlock(input.into),
    RESULT,
  ].join("\n\n");
