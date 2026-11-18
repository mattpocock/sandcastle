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
  reviewOutputSchema,
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
    name: `review-pr-${PR_NUMBER}`,
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
    output: Output.object({ tag: "output", schema: reviewOutputSchema }),
    extractionPrompt: fs.readFileSync(
      path.join(import.meta.dirname, "extraction.md"),
      "utf8",
    ),
  });

  const commits = await commitsSince(sandbox, before);
  if (commits > 0) {
    await pushBranch(sandbox, {
      branch: BRANCH,
      leaseSha: BRANCH_HEAD_SHA,
      advanced: "Branch advanced during review run.",
    });
  }
  const validInlineComments = filterInlineComments(
    result.output.inlineComments,
    context.diffLines,
  );
  const validReplies = filterReplies(
    result.output.replies,
    context.validReplyIds,
  );

  writeJson("review_payload.json", {
    commit_id: await headSha(sandbox),
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
  writeText("verdict.txt", commits > 0 ? "improved" : "clean");

  console.log("Review complete.");
  console.log(`Commits: ${commits}.`);
  console.log(`Inline comments: ${validInlineComments.length}.`);
  console.log(`Replies: ${validReplies.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
