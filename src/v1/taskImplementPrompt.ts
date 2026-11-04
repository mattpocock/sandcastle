// The `implement` task's own prompt: the slash command, then what the
// upstream `implement` skill doesn't do in a headless run that ends in a PR.

/** What the prompt is written from. */
export interface ImplementPromptInput {
  /** The ticket reference, or the work in the caller's words. */
  readonly work: { readonly ticket: string } | { readonly prompt: string };
  readonly branch: string;
  /** True when the branch was created for this run. */
  readonly newBranch: boolean;
  /** The review's comments, for round 2. */
  readonly feedback: string | undefined;
}

const entry = (work: ImplementPromptInput["work"]): string =>
  "ticket" in work
    ? `/implement ${work.ticket}\n\nStart by calling the Skill tool with skill "implement", for ticket ${work.ticket}. If you can't fetch the ticket, don't guess at it: stop, with status \`blocked\`.`
    : `/implement ${work.prompt.trim()}\n\nStart by calling the Skill tool with skill "implement", for the work described above.`;

const branchLine = (input: ImplementPromptInput): string =>
  input.newBranch
    ? `You're on \`${input.branch}\`, a new branch from the repository's default branch. Commit your work to it.`
    : `You're on \`${input.branch}\`, an existing branch. Commit your work to it.`;

const STEPS = [
  "How this run differs from the `implement` skill:",
  "- Skip its final step that calls the `code-review` skill: a separate review run reviews this work.",
  '- When the `tdd` skill asks you to confirm seams, use the seams the ticket names. If it names none, pick the highest existing seam yourself, and list it in the PR body under "Agent-chosen seams". Don\'t stop to ask.',
  '- When you\'re done, push the branch to `origin`. If it has no open PR, open one against the default branch with `gh pr create`; if it has one, update it. Write the PR body by calling the Skill tool with skill "pr". For evidence, use test and console output, never screenshots.',
  "- Never merge, approve or enable auto-merge on any PR. A human merges.",
  "- If nothing needed changing, don't open a PR.",
].join("\n");

const feedbackBlock = (feedback: string): string =>
  [
    "This is round 2. A review of this branch's PR left the comments below. Address them on the same branch, push, and update the PR.",
    "<review-feedback>",
    feedback.trim(),
    "</review-feedback>",
  ].join("\n");

const RESULT = [
  "End with your result in the `implementResult` tag, as JSON:",
  '`{ "status": "pr-opened" | "pr-updated" | "no-changes" | "blocked", "branch": string, "pr"?: { "number": number, "url": string }, "summary": string }`.',
  "Use `pr-opened` for a new PR, `pr-updated` when you pushed to an existing one, `no-changes` when nothing needed changing and `blocked` when you couldn't go on, with the reason in `summary`.",
].join("\n");

/** The task's prompt, before the parts every bundled task adds. */
export const implementPrompt = (input: ImplementPromptInput): string =>
  [
    entry(input.work),
    branchLine(input),
    STEPS,
    ...(input.feedback === undefined ? [] : [feedbackBlock(input.feedback)]),
    RESULT,
  ].join("\n\n");
