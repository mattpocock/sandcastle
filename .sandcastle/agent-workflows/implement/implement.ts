import * as path from "node:path";
import { claudeAgent, fail, required, tryGh } from "../shared/common";
import { renderPrompt } from "../shared/prompt";
import { runSession } from "../shared/run-with-extraction";
import {
  cloneRepo,
  commitsSince,
  openSandbox,
  pushBranch,
} from "../shared/sandbox";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");

try {
  const issueContext =
    tryGh(["issue", "view", ISSUE_NUMBER, "--comments"]) ||
    `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}`;

  await using sandbox = await openSandbox();
  await cloneRepo(sandbox, { newBranch: BRANCH });

  await runSession(sandbox, {
    name: `implement-${ISSUE_NUMBER}`,
    agent: claudeAgent(),
    prompt: await renderPrompt(
      path.join(import.meta.dirname, "prompt.md"),
      { ISSUE_NUMBER, ISSUE_TITLE, BRANCH, ISSUE_CONTEXT: issueContext },
      sandbox,
    ),
  });

  const commitsAhead = await commitsSince(sandbox, "origin/main");
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("Agent finished but no commits were made on the branch.");
  }
  await pushBranch(sandbox, { branch: BRANCH });

  console.log(`Implementation produced ${commitsAhead} commit(s).`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
