import { Config, Effect } from "effect";
import type { Choice, Chooser, ChooserContext } from "./chooser.js";
import { keepChoosable, ticketId } from "./chooser.js";
import type { SpecTicket, SpecTickets } from "./chooserGithubTickets.js";
import { githubSpecTickets } from "./chooserGithubTickets.js";
import type { JevClient } from "./chooserJevApi.js";
import { askJev } from "./chooserJevApi.js";

/** What `jevChooser` takes. */
export interface JevChooserOptions {
  /** Your TypeSafe API key. Default the `TYPESAFE_API_KEY` environment variable. */
  readonly apiKey?: string;
  /** The Jev model or alias to ask. Default `jev-latest`. */
  readonly model?: string;
  /** The `fetch` the requests go through. Default the global one. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Reads the spec and its tickets. Default: with `gh` in the sandbox, the
   * spec's issue and its sub-issues, for the `github` tracker. A custom
   * tracker needs its own. A rejection makes the choice `blocked`.
   */
  readonly read?: (context: ChooserContext) => Promise<SpecTickets>;
}

/** The option that ends the loop: nothing left can be built now. */
const NONE = "none_ready";

const INSTRUCTIONS = [
  "Which one of these tickets can be built now? A ticket can be built when every ticket it is blocked by is merged or closed.",
  "A ticket blocked by one that is open, chosen, stuck or skipped can't be built yet.",
  `Choose ${NONE} when none of the tickets can be built now.`,
].join(" ");

type Status = "open" | "closed" | "merged" | "stuck" | "skipped" | "chosen";

const statusOf = (
  ticket: SpecTicket,
  context: ChooserContext,
  chosen: readonly string[],
): Status => {
  const has = (list: readonly string[]) =>
    list.map((reference) => ticketId(reference)).includes(ticket.id);
  if (has(context.merged)) return "merged";
  if (has(context.stuck)) return "stuck";
  if (has(context.skipped)) return "skipped";
  if (!ticket.open) return "closed";
  return chosen.includes(ticket.id) ? "chosen" : "open";
};

/** The passage Jev reads: the spec, then every ticket with its status. */
const stateOf = (
  spec: SpecTickets,
  context: ChooserContext,
  chosen: readonly string[],
) => ({
  spec: { reference: context.spec, title: spec.title, body: spec.body },
  statuses: {
    merged: "built and merged; counts as done though its issue may be open",
    closed: "done",
    chosen: "being built now; not merged yet",
    stuck: "couldn't be finished; never built",
    skipped: "left out; never built",
    open: "not built yet",
  },
  tickets: spec.tickets.map((ticket) => ({
    id: ticket.id,
    title: ticket.title,
    status: statusOf(ticket, context, chosen),
    body: ticket.body,
  })),
});

const readSpec = async (
  read: NonNullable<JevChooserOptions["read"]>,
  context: ChooserContext,
): Promise<SpecTickets | string> =>
  read(context).catch(
    (error: unknown) =>
      `Couldn't read spec ${context.spec}: ${error instanceof Error ? error.message : String(error)}`,
  );

const openOf = (
  spec: SpecTickets,
  context: ChooserContext,
  chosen: readonly string[],
): readonly SpecTicket[] =>
  spec.tickets.filter((ticket) => statusOf(ticket, context, chosen) === "open");

/** What one choice reads and asks with. */
interface Choosing {
  readonly client: JevClient;
  readonly spec: SpecTickets;
  readonly context: ChooserContext;
}

/**
 * Asks Jev for one buildable ticket at a time, each question after the last,
 * until it picks `none_ready` or no open ticket is left.
 */
const chooseFrom = async (
  choosing: Choosing,
  chosen: readonly string[],
): Promise<Choice> => {
  const { client, spec, context } = choosing;
  const left = openOf(spec, context, chosen);
  const finished: Choice = {
    status: "ok",
    next: chosen,
    remaining: left.map((ticket) => ticket.id),
  };
  if (left.length === 0) {
    return finished;
  }
  const answer = await askJev(client, {
    state: stateOf(spec, context, chosen),
    instructions: INSTRUCTIONS,
    criteria: Object.fromEntries([
      ...left.map((ticket) => [ticket.id, ticket.title] as const),
      [NONE, "None of the other options can be built now."] as const,
    ]),
  });
  return left.some((ticket) => ticket.id === answer)
    ? chooseFrom(choosing, [...chosen, answer])
    : finished;
};

/** The key: the option, then `TYPESAFE_API_KEY`. An empty one counts as unset. */
const resolveKey = async (options: JevChooserOptions): Promise<string> => {
  const fromEnv = await Effect.runPromise(
    Config.string("TYPESAFE_API_KEY").pipe(Config.withDefault("")),
  );
  const key = options.apiKey ?? fromEnv;
  if (key === "") {
    throw new TypeError(
      "jevChooser: no TypeSafe API key; pass apiKey or set TYPESAFE_API_KEY",
    );
  }
  return key;
};

/** Rejects on a tracker the default reader can't read. */
const checkReader = (
  options: JevChooserOptions,
  context: ChooserContext,
): void => {
  if (
    options.read === undefined &&
    context.skillsContext.tracker.kind !== "github"
  ) {
    throw new TypeError(
      "jevChooser reads GitHub by default; pass read for a custom tracker",
    );
  }
};

/**
 * A chooser that asks Jev, TypeSafe's decision model, instead of running a
 * session. It reads the spec and its tickets (with `gh` in the sandbox by
 * default), then asks one Choice question at a time on the host: which open
 * ticket can be built now, with each such ticket an option and the spec and
 * every ticket's status as the state. Each ticket it picks is marked chosen
 * and dropped from the next question's options, until it picks `none_ready`
 * or none is left. Merged, stuck and skipped tickets are never options.
 *
 * The key is read when the chooser runs, and stays on the host: it is never
 * sent into the sandbox. The chooser rejects when there's no key, on a
 * custom tracker without `read`, and when a request to TypeSafe fails. A
 * spec that can't be read, or has no tickets, gives `blocked`.
 */
export const jevChooser =
  (options: JevChooserOptions = {}): Chooser =>
  async (context) => {
    checkReader(options, context);
    const client: JevClient = {
      apiKey: await resolveKey(options),
      model: options.model ?? "jev-latest",
      fetch: options.fetch ?? globalThis.fetch,
    };
    const spec = await readSpec(options.read ?? githubSpecTickets, context);
    if (typeof spec === "string") {
      return { status: "blocked", next: [], remaining: [], reason: spec };
    }
    if (spec.tickets.length === 0) {
      return {
        status: "blocked",
        next: [],
        remaining: [],
        reason: `Spec ${context.spec} has no tickets.`,
      };
    }
    return keepChoosable(
      await chooseFrom({ client, spec, context }, []),
      context,
    );
  };
