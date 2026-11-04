import type { CheckedOutPullRequest } from "./taskPullRequest.js";

// The review task's own prompt. code-review reports two axes and leaves the
// verdict open on purpose; the task owns the verdict, the single PR comment
// and the `reviewResult` it hands back.

const ticketRef = (ticket: CheckedOutPullRequest["tickets"][number]): string =>
  `#${ticket.number} (${ticket.url})`;

const specLine = (tickets: CheckedOutPullRequest["tickets"]): string =>
  tickets.length === 0
    ? 'There is no spec: the pull request links no ticket, so skip the Spec sub-agent and report "no spec available" for that axis.'
    : `The spec is the ticket the pull request closes: ${tickets.map((ticket) => ticketRef(ticket)).join(", ")}. Fetch it with the issue tracker instructions below.`;

const VERDICT_RULE =
  "Then decide one verdict for the whole pull request. It is `changes-requested` when the Standards axis found any hard violation of a documented standard, or the Spec axis found a requirement that is missing, partial or implemented wrongly. Otherwise it is `approve`: smells, judgement calls and scope creep alone don't request changes.";

const commentRule = (pr: number): string =>
  `Post the aggregated review, with the verdict on its first line, as exactly one comment on pull request #${pr}: write it to a file outside the clone and run \`gh pr comment ${pr} --body-file <file>\` once. Never post a second comment, never approve or request changes with \`gh pr review\`, and never merge. Don't edit, commit or push any code.`;

const RESULT_SHAPE =
  'Your result is `{"verdict": "approve" | "changes-requested", "comments": [...], "summary": "..."}`. `comments` holds every finding behind a `changes-requested` verdict, one self-contained string each that names its axis, the file and what to change, so a fresh session can act on it without this review; it is empty when you approve. `summary` is the review\'s one-line summary.';

/** `/code-review` with the fixed point and the spec given, then the task's verdict, comment and result rules. */
export const reviewPrompt = (
  pr: number,
  checkedOut: CheckedOutPullRequest,
): string =>
  [
    `/code-review The fixed point is \`origin/${checkedOut.base}\`: review the diff between it and \`HEAD\`, which is pull request #${pr}'s branch \`${checkedOut.head}\`, already checked out. ${specLine(checkedOut.tickets)} Run the Standards and Spec sub-agents with the Agent tool, as the skill says.`,
    VERDICT_RULE,
    commentRule(pr),
    RESULT_SHAPE,
  ].join("\n\n");
