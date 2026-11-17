import { Either, Schema } from "effect";
import { shellEscape } from "../AgentProvider.js";
import type { ChooserContext } from "./chooser.js";
import { ticketId } from "./chooser.js";

// Reading a spec and its tickets from GitHub with `gh`, for a chooser that
// runs on the host: the spec's title and body, then its sub-issues. The
// token and the repo reach these commands' env only.

/** One of a spec's tickets, as a chooser reads it. */
export interface SpecTicket {
  /** Its tracker reference, e.g. `42`. */
  readonly id: string;
  readonly title: string;
  /** Its full text, which says what it's blocked by. */
  readonly body: string;
  /** `false` once it's closed in the tracker. */
  readonly open: boolean;
}

/** A spec and its tickets, as a chooser reads them. */
export interface SpecTickets {
  readonly title: string;
  readonly body: string;
  readonly tickets: readonly SpecTicket[];
}

const Issue = Schema.parseJson(
  Schema.Struct({
    title: Schema.String,
    body: Schema.NullOr(Schema.String),
  }),
);

const SubIssue = Schema.parseJson(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    body: Schema.NullOr(Schema.String),
    state: Schema.String,
  }),
);

const decode = <A>(
  schema: Schema.Schema<A, string>,
  text: string,
  what: string,
): A => {
  const decoded = Schema.decodeUnknownEither(schema)(text);
  if (Either.isLeft(decoded)) {
    throw new Error(`Couldn't read ${what}: ${decoded.left.message}`);
  }
  return decoded.right;
};

/**
 * The spec and its sub-issues, read with `gh` in the sandbox. Rejects when
 * `gh` fails (no such issue, no access) or prints something else.
 */
export const githubSpecTickets = async (
  context: ChooserContext,
): Promise<SpecTickets> => {
  const spec = ticketId(context.spec);
  const env = { GH_TOKEN: context.githubToken, GH_REPO: context.repo };
  const viewed = await context.sandbox.exec({
    command: `gh issue view ${shellEscape(spec)} --json title,body`,
    env,
  });
  const issue = decode(Issue, viewed.stdout, `spec ${spec}`);
  const listed = await context.sandbox.exec({
    command: `gh api --paginate ${shellEscape(`repos/{owner}/{repo}/issues/${spec}/sub_issues`)} --jq '.[] | {number, title, body, state}'`,
    env,
  });
  const tickets = listed.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decode(SubIssue, line, `spec ${spec}'s sub-issues`))
    .map((ticket) => ({
      id: String(ticket.number),
      title: ticket.title,
      body: ticket.body ?? "",
      open: ticket.state === "open",
    }));
  return { title: issue.title, body: issue.body ?? "", tickets };
};
