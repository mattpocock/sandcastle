import type { Sandbox } from "../v1.js";
import { remoteHasBranch } from "./implementSpecBranch.js";
import type {
  ImplementSpecInput,
  ImplementSpecState,
} from "./implementSpecTypes.js";

// What `implementSpec` checks itself before it starts a ticket's session:
// the parts of a start that come from an agent, one ticket at a time. The
// chooser named the ticket, and the ticket's `implement` session reported the
// branch its merge takes. A problem here is that ticket's, so it ends stuck.
// Anything a start rejects with after these checks pass (a clone, fetch,
// setup command, skill install or spawn that fails) is the sandbox's, the
// repo's or the input's, would hit every ticket alike, and makes `start` or
// `next` reject instead, leaving the state for the caller to retry.

/** A ticket reference that can be part of a session name, and of the clone's directory. */
const REFERENCE = /^[\w.-]+$/u;

/** Why the chooser's `ticket` can't start, or `undefined` when it can. */
export const ticketProblem = (ticket: string): string | undefined =>
  REFERENCE.test(ticket)
    ? undefined
    : `the chooser chose "${ticket}", which can't name a session: a ticket reference is letters, digits, "_", "." and "-"`;

/** Why the merge of `ticket`'s branch can't start, or `undefined` when it can. */
export const mergeProblem = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  {
    state,
    ticket,
  }: { readonly state: ImplementSpecState; readonly ticket: string },
): Promise<string | undefined> => {
  const branch = state.tickets[ticket]?.branch ?? "";
  if (branch === "" || branch.startsWith("-") || branch === state.branch) {
    return `its implement session reported "${branch}" as its branch, which isn't a ticket branch to merge`;
  }
  const found = await remoteHasBranch(sandbox, {
    repo: input.repo,
    branch,
    githubToken: input.githubToken,
  });
  return found
    ? undefined
    : `its implement session reported the branch "${branch}", which isn't on the remote`;
};
