import { Schema } from "effect";
import type { OutputObjectDefinition } from "./Output.js";
import { Output } from "./Output.js";
import type { Sandbox } from "./Sandbox.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import type { TaskSkillsContext } from "./Task.js";

// The chooser: the primitive that picks which of a spec's tickets to build
// next. Any function of this type is one; `sessionChooser` and `jevChooser`
// are the two that ship.

/** Which tickets to build next, and which are left after them. */
export interface Choice {
  /**
   * `blocked` when the spec can't be read or has no tickets, with the
   * `reason`. `ok` otherwise, even when nothing can be built yet: `next` is
   * then empty.
   */
  readonly status: "ok" | "blocked";
  /** The open tickets to build now: every ticket each one is blocked by is merged or closed. */
  readonly next: readonly string[];
  /** The other open tickets, still to build after `next`. Merged, stuck and skipped tickets are in neither. */
  readonly remaining: readonly string[];
  /** Why the choice is `blocked`, or anything else worth knowing about it. */
  readonly reason?: string;
}

/** What a chooser is told: the spec, where to read it, and how far the work on it has got. */
export interface ChooserContext {
  /** The spec, as a tracker reference: an issue number such as `671` on GitHub. */
  readonly spec: string;
  /** The spec's repo, `owner/name` on GitHub. */
  readonly repo: string;
  /** The sandbox the work runs in. A chooser may run commands or a session on it. */
  readonly sandbox: Sandbox;
  /** A GitHub token that can read the spec and its tickets. It reaches only the commands and sessions that read them. */
  readonly githubToken: string;
  /** The tracker the spec and its tickets live in. */
  readonly skillsContext: TaskSkillsContext;
  /** Which choice this is, from 1. A session chooser names its session after it. */
  readonly round: number;
  /** Tickets already built and merged into the work's branch. Their tickets may still be open. */
  readonly merged: readonly string[];
  /** Tickets that couldn't be finished. Never chosen, and nor is anything blocked by one. */
  readonly stuck: readonly string[];
  /** Tickets left out because a ticket they're blocked by is stuck. Never chosen. */
  readonly skipped: readonly string[];
  /** Where a session chooser's record goes when it ends. Default none. */
  readonly record?: SessionRecordOptions;
}

/**
 * Picks the next tickets of a spec to build. `sessionChooser()` and
 * `jevChooser()` make one, and so does any function of this type.
 */
export type Chooser = (context: ChooserContext) => Promise<Choice>;

/** The `choice` output a chooser session ends with. */
export const CHOICE: OutputObjectDefinition<Choice> = Output.object({
  tag: "choice",
  schema: Schema.standardSchemaV1(
    Schema.Struct({
      status: Schema.Literal("ok", "blocked"),
      next: Schema.Array(Schema.String),
      remaining: Schema.Array(Schema.String),
      reason: Schema.optional(Schema.String),
    }),
  ),
});

/** A ticket reference without GitHub's leading `#`. */
export const ticketId = (reference: string): string =>
  reference.trim().replace(/^#/u, "");

/**
 * `choice` with every merged, stuck and skipped ticket taken out of `next`
 * and `remaining`, whatever the chooser said. A blocked choice builds nothing.
 */
export const keepChoosable = (
  choice: Choice,
  context: ChooserContext,
): Choice => {
  const done = new Set(
    [...context.merged, ...context.stuck, ...context.skipped].map((ticket) =>
      ticketId(ticket),
    ),
  );
  const open = (tickets: readonly string[]) =>
    tickets.filter((ticket) => !done.has(ticketId(ticket)));
  return {
    status: choice.status,
    next: choice.status === "blocked" ? [] : open(choice.next),
    remaining: open(choice.remaining),
    ...(choice.reason === undefined ? {} : { reason: choice.reason }),
  };
};
