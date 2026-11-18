import * as fs from "node:fs";
import * as path from "node:path";
import { Output } from "@ai-hero/sandcastle/v1";
import {
  claudeAgent,
  fail,
  required,
  writeJson,
  writeText,
} from "../shared/common";
import { renderPrompt } from "../shared/prompt";
import { fetchPullRequestContext } from "../shared/review-context";
import {
  filterInlineComments,
  filterReplies,
  implementPrOutputSchema,
} from "../shared/review-output";
import { runWithExtraction } from "../shared/run-with-extraction";
import {
  cloneRepo,
  commitsSince,
  headSha,
  openSandbox,
  pushBranch,
} from "../shared/sandbox";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");
const BRANCH_HEAD_SHA = required("BRANCH_HEAD_SHA");

try {
  await using sandbox = await openSandbox();
  await cloneRepo(sandbox, { branch: BRANCH });
  const context = await fetchPullRequestContext(PR_NUMBER, sandbox);
  const before = await headSha(sandbox);

  const result = await runWithExtraction({
    sandbox,
    name: `implement-pr-${PR_NUMBER}`,
    agent: claudeAgent(),
    prompt: await renderPrompt(
      path.join(import.meta.dirname, "prompt.md"),
      {
        PR_NUMBER,
        BRANCH,
        PR_TITLE: context.prTitle,
        ISSUE_NUMBER: context.issueNumber || "(none)",
        ISSUE_TITLE: context.issueTitle || "(no linked issue)",
        LINKED_ISSUE: context.linkedIssue,
        DIFF_TO_MAIN: context.diff,
        PR_COMMENTS_JSON: context.prCommentsJson,
      },
      sandbox,
    ),
    output: Output.object({ tag: "output", schema: implementPrOutputSchema }),
    extractionPrompt: fs.readFileSync(
      path.join(import.meta.dirname, "extraction.md"),
      "utf8",
    ),
  });

  const threadReplies = filterReplies(
    result.output.threadReplies,
    context.validReplyIds,
  );
  const newInlineComments = filterInlineComments(
    result.output.newInlineComments,
    context.diffLines,
  );
  const commits = await commitsSince(sandbox, before);
  const hasCommits = commits > 0;

  if (
    !hasCommits &&
    threadReplies.length === 0 &&
    newInlineComments.length === 0 &&
    result.output.topLevelComments.length === 0
  ) {
    fail("Agent finished but made no commits and emitted no comments.");
  }
  if (hasCommits) {
    await pushBranch(sandbox, {
      branch: BRANCH,
      leaseSha: BRANCH_HEAD_SHA,
      advanced: "Branch advanced during implement-PR run.",
    });
  }

  writeText("has_commits.txt", hasCommits ? "true" : "false");
  writeJson("implement_thread_replies.json", threadReplies);
  writeJson("implement_new_inline_comments.json", newInlineComments);
  writeJson(
    "implement_top_level_comments.json",
    result.output.topLevelComments,
  );

  console.log("Implement PR complete.");
  console.log(`Commits: ${commits}.`);
  console.log(`Thread replies: ${threadReplies.length}.`);
  console.log(`Inline comments: ${newInlineComments.length}.`);
  console.log(`Top-level comments: ${result.output.topLevelComments.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
