import type { Sandbox, SessionProcess } from "../v1.js";
import type { Choice } from "./chooser.js";
import { sessionChooser } from "./chooserSession.js";
import type { ImplementResult } from "./implementResult.js";
import { checkRoom, common, messageOf } from "./implementSpecCommon.js";
import type { RoundEnd } from "./implementSpecProgress.js";
import { applyOutcomes, ticketsWith } from "./implementSpecProgress.js";
import {
  afterReview,
  integrate,
  isReviewRound,
} from "./implementSpecReview.js";
import type {
  ImplementSpecInput,
  ImplementSpecState,
  ImplementSpecStep,
  ImplementSpecTicket,
} from "./implementSpecTypes.js";
import { implement } from "./taskImplement.js";
import { merge } from "./taskMerge.js";

// What `implementSpec` spawns between rounds: the next merge when a PR waits
// for one, else the chooser and the next ticket round, and once the chooser
// has nothing left, the integration PR and its review. Every session is an
// ordinary bundled task's, started through its public `start`.

const sessionName = (
  step: "implement" | "merge",
  ticket: string,
  progress: ImplementSpecTicket | undefined,
): string =>
  progress?.retried === true ? `${step}-${ticket}-retry` : `${step}-${ticket}`;

const withTicket = (
  state: ImplementSpecState,
  ticket: string,
  progress: ImplementSpecTicket,
): ImplementSpecState => ({
  ...state,
  tickets: { ...state.tickets, [ticket]: progress },
});

const stuck = (
  state: ImplementSpecState,
  ticket: string,
  error: unknown,
): ImplementSpecState =>
  withTicket(state, ticket, {
    ...state.tickets[ticket],
    status: "stuck",
    retried: state.tickets[ticket]?.retried ?? false,
    summary: `couldn't start: ${messageOf(error)}`,
  });

/** Starts the merge of the first waiting PR; a start that fails leaves it stuck. */
const mergeRound = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  state: ImplementSpecState,
): Promise<ImplementSpecStep> => {
  const [ticket = "", ...merges] = state.merges;
  const progress = state.tickets[ticket];
  const name = sessionName("merge", ticket, progress);
  const rest = { ...state, merges };
  try {
    const spawned = await merge.start(sandbox, {
      ...common(input),
      name,
      from: progress?.branch ?? "",
      into: state.branch,
    });
    return {
      done: false,
      state: {
        ...withTicket(rest, ticket, {
          ...progress,
          status: "merging",
          retried: progress?.retried ?? false,
        }),
        round: state.round + 1,
        sessions: { [name]: { step: "merge", ticket } },
      },
      sessions: { [name]: spawned },
    };
  } catch (error) {
    return advance(sandbox, input, stuck(rest, ticket, error));
  }
};

/** Runs the chooser, as round `state.choices + 1`. */
const choose = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  state: ImplementSpecState,
): Promise<Choice> => {
  const chooser =
    input.chooser ??
    sessionChooser(input.agent === undefined ? {} : { agent: input.agent });
  return chooser({
    spec: input.spec,
    repo: input.repo,
    sandbox,
    githubToken: input.githubToken,
    skillsContext: input.skillsContext,
    round: state.choices + 1,
    merged: ticketsWith(state, "merged"),
    stuck: ticketsWith(state, "stuck"),
    skipped: ticketsWith(state, "skipped"),
    ...(input.record === undefined ? {} : { record: input.record }),
  });
};

const OVER = new Set(["merged", "stuck", "skipped"]);

/** The choice's tickets that are still open, without a leading `#`, each once. */
const open = (state: ImplementSpecState, tickets: readonly string[]) => [
  ...new Set(
    tickets
      .map((ticket) => ticket.trim().replace(/^#/u, ""))
      .filter((ticket) => !OVER.has(state.tickets[ticket]?.status ?? "")),
  ),
];

/** The state with every remaining ticket marked skipped. */
const skipRest = (
  state: ImplementSpecState,
  remaining: readonly string[],
): ImplementSpecState =>
  open(state, remaining).reduce(
    (current, ticket) =>
      withTicket(current, ticket, {
        status: "skipped",
        retried: false,
        summary: "a ticket it's blocked by couldn't be finished",
      }),
    state,
  );

/** The tickets the chooser chose for a round, and the state they were chosen in. */
interface ChosenRound {
  readonly state: ImplementSpecState;
  readonly tickets: readonly string[];
}

type Started = PromiseSettledResult<SessionProcess<ImplementResult>>;

/** The round's state once its starts settled: each started ticket implementing, the rest stuck. */
const startedState = (
  round: ChosenRound,
  started: readonly Started[],
): ImplementSpecState => {
  let next: ImplementSpecState = { ...round.state, sessions: {} };
  for (const [index, outcome] of started.entries()) {
    const ticket = round.tickets[index] ?? "";
    next =
      outcome.status === "rejected"
        ? stuck(next, ticket, outcome.reason)
        : {
            ...withTicket(next, ticket, {
              status: "implementing",
              retried: round.state.tickets[ticket]?.retried ?? false,
            }),
            sessions: {
              ...next.sessions,
              [outcome.value.name]: { step: "implement", ticket },
            },
          };
  }
  return next;
};

/** Starts one `implement` session per chosen ticket; a start that fails leaves its ticket stuck. */
const ticketRound = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  round: ChosenRound,
): Promise<ImplementSpecStep> => {
  const { state, tickets } = round;
  const started = await Promise.allSettled(
    tickets.map(async (ticket) =>
      implement.start(sandbox, {
        ...common(input),
        name: sessionName("implement", ticket, state.tickets[ticket]),
        ticket,
        base: state.branch,
      }),
    ),
  );
  const next = startedState(round, started);
  const sessions = Object.fromEntries(
    started.flatMap((outcome) =>
      outcome.status === "fulfilled"
        ? [[outcome.value.name, outcome.value] as const]
        : [],
    ),
  );
  if (Object.keys(sessions).length === 0) {
    return advance(sandbox, input, next);
  }
  return { done: false, state: { ...next, round: state.round + 1 }, sessions };
};

/**
 * The next round from `state`, whose last round is over: the next merge, or
 * else the chooser's next tickets, or the end when it chooses none.
 */
export const advance = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  state: ImplementSpecState,
): Promise<ImplementSpecStep> => {
  checkRoom(sandbox);
  if (state.merges.length > 0) {
    return mergeRound(sandbox, input, state);
  }
  const choice = await choose(sandbox, input, state);
  const chosen = { ...state, choices: state.choices + 1 };
  if (choice.status === "blocked") {
    return integrate(sandbox, input, {
      ...chosen,
      blocked: choice.reason ?? "the chooser said blocked",
    });
  }
  const next = open(chosen, choice.next).slice(0, input.maxConcurrent ?? 3);
  if (next.length === 0) {
    return integrate(sandbox, input, skipRest(chosen, choice.remaining));
  }
  return ticketRound(sandbox, input, { state: chosen, tickets: next });
};

/** The next step once the round `ended.state` spawned ended with `ended.outcomes`. */
export const afterRound = async (
  sandbox: Sandbox,
  input: ImplementSpecInput,
  ended: RoundEnd,
): Promise<ImplementSpecStep> =>
  isReviewRound(ended.state)
    ? afterReview(sandbox, input, ended)
    : advance(sandbox, input, applyOutcomes(ended.state, ended.outcomes));
