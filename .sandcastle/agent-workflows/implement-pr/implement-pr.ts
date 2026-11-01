import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  claudeAgent,
  fail,
  required,
  writeJson,
  writeText,
} from "../shared/common";
import { fetchPullRequestContext } from "../shared/review-context";
import {
  filterInlineComments,
  filterReplies,
  implementPrOutputSchema,
} from "../shared/review-output";
import { runWithExtraction } from "../shared/run-with-extraction";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");

try {
  const context = fetchPullRequestContext(PR_NUMBER);

  const result = await runWithExtraction({
    name: `implement-pr-${PR_NUMBER}`,
    agent: claudeAgent(),
    sandbox: noSandbox(),
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      PR_NUMBER,
      BRANCH,
      PR_TITLE: context.prTitle,
      ISSUE_NUMBER: context.issueNumber || "(none)",
      ISSUE_TITLE: context.issueTitle || "(no linked issue)",
      LINKED_ISSUE: context.linkedIssue,
      DIFF_TO_MAIN: context.diff,
      PR_COMMENTS_JSON: context.prCommentsJson,
    },
    output: sandcastle.Output.object({
      tag: "output",
      schema: implementPrOutputSchema,
    }),
    extractionPrompt: await readFile(
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
  const hasCommits = result.commits.length > 0;

  if (
    !hasCommits &&
    threadReplies.length === 0 &&
    newInlineComments.length === 0 &&
    result.output.topLevelComments.length === 0
  ) {
    fail("Agent finished but made no commits and emitted no comments.");
  }

  writeText("has_commits.txt", hasCommits ? "true" : "false");
  writeJson("implement_thread_replies.json", threadReplies);
  writeJson("implement_new_inline_comments.json", newInlineComments);
  writeJson(
    "implement_top_level_comments.json",
    result.output.topLevelComments,
  );

  console.log("Implement PR complete.");
  console.log(`Commits: ${result.commits.length}.`);
  console.log(`Thread replies: ${threadReplies.length}.`);
  console.log(`Inline comments: ${newInlineComments.length}.`);
  console.log(`Top-level comments: ${result.output.topLevelComments.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
