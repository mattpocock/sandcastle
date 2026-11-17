import type { AgentProvider } from "./agents.js";
import { claudeCode } from "./agents.js";
import type { Chooser, ChooserContext } from "./chooser.js";
import { CHOICE, keepChoosable } from "./chooser.js";
import { checkAgentOptions } from "./sessionRequest.js";
import { taskPrompt } from "./taskPrompt.js";

/** What `sessionChooser` takes. */
export interface SessionChooserOptions {
  /**
   * The agent and model the chooser's session runs, such as
   * `claudeCode("sonnet")`, or `fakeAgent()` from `/v1/testing` in tests.
   * Default Claude Code on Haiku: the choice is a short, structured read of
   * the tracker.
   */
  readonly agent?: AgentProvider;
}

const listed = (label: string, tickets: readonly string[]): string =>
  `${label}: ${tickets.length === 0 ? "none" : tickets.join(", ")}.`;

/** The chooser session's own prompt, before the parts every task adds. */
const choosePrompt = (context: ChooserContext): string =>
  [
    `Choose which tickets of spec ${context.spec} in ${context.repo} to build next.`,
    "Read the spec and each of its tickets through the issue tracker below. Its tickets are its sub-issues, or else the tickets its body lists. Read only: don't comment, label, close or edit anything.",
    "How far the work has got (tickets not listed are untouched):",
    listed("Merged", context.merged),
    listed("Stuck", context.stuck),
    listed("Skipped", context.skipped),
    "A merged ticket counts as done even while its issue is still open. Stuck and skipped tickets are never built, and nor is any ticket blocked by one.",
    "In `next`, list every open ticket that isn't merged, stuck or skipped and whose blockers are all merged or closed. In `remaining`, list the other open tickets that aren't merged, stuck or skipped. Give each ticket as its number alone, e.g. `42`.",
    "Set `status` to `ok`, even when `next` is empty. Set it to `blocked`, with the `reason`, only when you can't read the spec or it has no tickets.",
  ].join("\n\n");

/**
 * A chooser that runs one session on the sandbox, named `choose-<round>`:
 * Claude Code on Haiku unless you pass `agent`. The session reads the spec
 * and its tickets through the tracker instructions, with the GitHub token as
 * `GH_TOKEN` and the repo as `GH_REPO`, and ends with a structured `choice`.
 * Merged, stuck and skipped tickets are taken out of it whatever the session
 * says. It rejects with `SessionFailedError` when the session fails, or
 * `StructuredOutputError` when its `choice` is missing or malformed.
 */
export const sessionChooser = (
  options: SessionChooserOptions = {},
): Chooser => {
  const agent = options.agent ?? claudeCode("haiku");
  checkAgentOptions({ agent });
  return async (context) => {
    const done = await context.sandbox.session({
      name: `choose-${context.round}`,
      agent,
      prompt: taskPrompt({
        body: choosePrompt(context),
        tracker: context.skillsContext.tracker,
        output: CHOICE,
      }),
      output: CHOICE,
      env: { GH_TOKEN: context.githubToken, GH_REPO: context.repo },
      ...(context.record === undefined ? {} : { record: context.record }),
    });
    return keepChoosable(done.output, context);
  };
};
