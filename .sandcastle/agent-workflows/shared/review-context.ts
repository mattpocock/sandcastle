import { gh, isRecord, safeSh, sh, textOr } from "./common";
import { parseDiffLines } from "./diff-lines";

export interface ReviewThreadComment {
  readonly commentId: string;
  readonly threadId: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly author: string;
  readonly body: string;
}

export interface PullRequestContext {
  readonly prTitle: string;
  readonly prBody: string;
  readonly issueNumber: string;
  readonly issueTitle: string;
  readonly linkedIssue: string;
  readonly diff: string;
  readonly prCommentsJson: string;
  readonly diffLines: Map<string, Set<number>>;
  readonly validReplyIds: Set<string>;
}

/** The issue a PR body closes (`Closes #12`), or "" when it names none. */
const linkedIssueNumber = (body: string): string =>
  /(?:closes|fixes|resolves)\s+#(?<issue>\d+)/iu.exec(body)?.groups?.issue ??
  "";

// --- Narrowing `gh` JSON ------------------------------------------------------

/** `value[key]` when `value` is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

/** `value` as an array, or [] when it isn't one (GitHub omitted the list). */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

/** The `login` of a GitHub actor (`author`, `user`), or "unknown". */
const login = (actor: unknown): string =>
  textOr(field(actor, "login"), "unknown");

/** Unresolved review-thread comments from the `reviewThreads` GraphQL query. */
const unresolvedThreadComments = (response: unknown): ReviewThreadComment[] => {
  const threads = list(
    field(
      field(
        field(field(field(response, "data"), "repository"), "pullRequest"),
        "reviewThreads",
      ),
      "nodes",
    ),
  );
  return threads
    .filter((thread) => field(thread, "isResolved") !== true)
    .flatMap((thread) =>
      list(field(field(thread, "comments"), "nodes")).map((comment) => ({
        commentId: textOr(field(comment, "id"), ""),
        threadId: textOr(field(thread, "id"), ""),
        path: stringOrNull(field(comment, "path")),
        line:
          numberOrNull(field(comment, "line")) ??
          numberOrNull(field(comment, "originalLine")),
        author: login(field(comment, "author")),
        body: textOr(field(comment, "body"), ""),
      })),
    );
};

export const fetchPullRequestContext = (
  prNumber: string,
): PullRequestContext => {
  const prView: unknown = JSON.parse(
    gh(["pr", "view", prNumber, "--json", "title,body,comments"]),
  );
  const prTitle = textOr(field(prView, "title"), "");
  const prBody = textOr(field(prView, "body"), "");

  const issueNumber = linkedIssueNumber(prBody);
  const issueTitle = issueNumber
    ? safeSh(`gh issue view ${issueNumber} --json title --jq .title`).trim()
    : "";
  const linkedIssue = issueNumber
    ? safeSh(`gh issue view ${issueNumber} --comments`)
    : "(no linked issue found)";

  const reviews = list(
    JSON.parse(gh(["api", `repos/{owner}/{repo}/pulls/${prNumber}/reviews`])),
  );

  const [owner, repo] = (process.env.GH_REPO ?? "").split("/");
  const query = `
query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first:50) {
            nodes {
              id
              path
              line
              originalLine
              body
              author { login }
            }
          }
        }
      }
    }
  }
}`;

  const threadsParsed: unknown = JSON.parse(
    gh([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${prNumber}`,
      "-f",
      `query=${query}`,
    ]),
  );
  const reviewThreads = unresolvedThreadComments(threadsParsed);

  const prComments = {
    issue_comments: list(field(prView, "comments")).map((comment) => ({
      author: login(field(comment, "author")),
      body: textOr(field(comment, "body"), ""),
      createdAt: field(comment, "createdAt"),
    })),
    review_summaries: reviews
      .map((review) => ({
        author: login(field(review, "user")),
        state: textOr(field(review, "state"), ""),
        body: textOr(field(review, "body"), ""),
        submittedAt: stringOrNull(field(review, "submitted_at")),
      }))
      .filter((review) => review.body.trim().length > 0),
    review_threads: reviewThreads,
  };

  const diff = safeSh("git diff main...HEAD") || sh("git diff main..HEAD");

  return {
    prTitle,
    prBody,
    issueNumber,
    issueTitle,
    linkedIssue,
    diff,
    prCommentsJson: JSON.stringify(prComments, null, 2),
    diffLines: parseDiffLines(diff),
    validReplyIds: new Set(reviewThreads.map((comment) => comment.commentId)),
  };
};
