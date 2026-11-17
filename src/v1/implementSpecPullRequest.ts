import type { Sandbox } from "../v1.js";
import {
  credentials,
  integrationClone,
  quoted,
} from "./implementSpecBranch.js";
import { ticketsWith } from "./implementSpecProgress.js";
import type {
  ImplementSpecPullRequest,
  ImplementSpecState,
} from "./implementSpecTypes.js";

// The integration PR: the integration branch against the default branch,
// opened by `exec` and `gh` in the integration branch's own clone, with a
// body from a template. Never merged. The token reaches these commands' env
// only.

/** A ticket or spec reference as GitHub writes it: `42` is `#42`. */
const issue = (reference: string): string => `#${reference.replace(/^#/u, "")}`;

const section = (title: string, lines: readonly string[]): string[] =>
  lines.length === 0 ? [] : [`## ${title}`, "", ...lines, ""];

/**
 * The PR's body: the merged, stuck and skipped tickets, a `Closes` line for
 * each merged ticket, and the spec's own only when every ticket merged.
 */
export const integrationBody = (state: ImplementSpecState): string => {
  const merged = ticketsWith(state, "merged");
  const stuck = ticketsWith(state, "stuck");
  const skipped = ticketsWith(state, "skipped");
  const summaryOf = (ticket: string): string => {
    const summary = state.tickets[ticket]?.summary?.trim() ?? "";
    return summary === "" ? "" : `: ${summary}`;
  };
  const closes = [
    ...merged,
    ...(stuck.length === 0 && skipped.length === 0 ? [state.spec] : []),
  ];
  return [
    `Spec ${issue(state.spec)}, built ticket by ticket onto \`${state.branch}\`. Each ticket's own PR merged into this branch; this PR is left for a human to merge.`,
    "",
    ...section(
      "Merged",
      merged.map((ticket) => `- ${issue(ticket)}${summaryOf(ticket)}`),
    ),
    ...section(
      "Stuck",
      stuck.map((ticket) => `- ${issue(ticket)}${summaryOf(ticket)}`),
    ),
    ...section(
      "Skipped (blocked by a stuck ticket)",
      skipped.map((ticket) => `- ${issue(ticket)}`),
    ),
    ...closes.map((reference) => `Closes ${issue(reference)}`),
  ].join("\n");
};

const PR_URL = /^https?:\/\/\S+\/pull\/(?<number>\d+)\s*$/mu;

/**
 * Opens the integration branch's PR against the default branch. Resolves
 * `undefined`, opening nothing, when the branch has no commits the default
 * branch lacks: every merged ticket needed no changes.
 */
export const openIntegrationPr = async (
  sandbox: Sandbox,
  options: { readonly state: ImplementSpecState; readonly githubToken: string },
): Promise<ImplementSpecPullRequest | undefined> => {
  const { state } = options;
  const run = {
    workingDirectory: integrationClone(sandbox, state.branch),
    env: { GH_TOKEN: options.githubToken },
  };
  const head = await sandbox.exec({
    ...run,
    command: `git ${credentials} fetch --quiet origin && git rev-parse --abbrev-ref refs/remotes/origin/HEAD`,
  });
  const base = head.stdout.trim().replace(/^origin\//u, "");
  const ahead = await sandbox.exec({
    ...run,
    command: `git rev-list --count ${quoted(`refs/remotes/origin/${base}..refs/remotes/origin/${state.branch}`)}`,
  });
  if (Number(ahead.stdout.trim()) === 0) {
    return undefined;
  }
  const created = await sandbox.exec({
    ...run,
    command: `gh pr create --base ${quoted(base)} --head ${quoted(state.branch)} --title ${quoted(`Implement spec ${issue(state.spec)}`)} --body ${quoted(integrationBody(state))}`,
  });
  const url = PR_URL.exec(created.stdout);
  if (url === null) {
    throw new Error(
      `implementSpec: gh pr create printed no PR URL: ${created.stdout.trim()}`,
    );
  }
  return { number: Number(url.groups?.number), url: url[0].trim() };
};
