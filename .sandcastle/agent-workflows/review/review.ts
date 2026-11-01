import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import {
  claudeAgent,
  fail,
  required,
  sh,
  writeJson,
  writeText,
} from "../shared/common";
import { fetchPullRequestContext } from "../shared/review-context";
import {
  filterInlineComments,
  filterReplies,
  reviewOutputSchema,
} from "../shared/review-output";
import { runWithExtraction } from "../shared/run-with-extraction";

const PR_NUMBER = required("PR_NUMBER");
const BRANCH = required("BRANCH");

try {
  const context = fetchPullRequestContext(PR_NUMBER);

  const result = await runWithExtraction({
    name: `review-pr-${PR_NUMBER}`,
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
      schema: reviewOutputSchema,
    }),
    extractionPrompt: await readFile(
      path.join(import.meta.dirname, "extraction.md"),
      "utf8",
    ),
  });

  const validInlineComments = filterInlineComments(
    result.output.inlineComments,
    context.diffLines,
  );
  const validReplies = filterReplies(
    result.output.replies,
    context.validReplyIds,
  );
  const headSha = sh("git rev-parse HEAD").trim();

  writeJson("review_payload.json", {
    commit_id: headSha,
    event: "COMMENT",
    body: result.output.summary,
    comments: validInlineComments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });
  writeJson("replies.json", validReplies);
  writeText("summary.md", result.output.summary);
  writeText("verdict.txt", result.commits.length > 0 ? "improved" : "clean");

  console.log("Review complete.");
  console.log(`Commits: ${result.commits.length}.`);
  console.log(`Inline comments: ${validInlineComments.length}.`);
  console.log(`Replies: ${validReplies.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
