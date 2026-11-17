import { DateTime } from "effect";
import type { Sandbox } from "../v1.js";
import { resultOf } from "./implementSpecProgress.js";
import type {
  ImplementSpecInput,
  ImplementSpecState,
  ImplementSpecStep,
} from "./implementSpecTypes.js";

// What every step of `implementSpec` shares: its limits, the room check
// before a round, what each composed task takes from the input, and the end.

/** `implementSpec.limits`: the sandbox's whole life, and one round's deadline. */
export const LIMITS = { timeLimitMinutes: 480, deadlineMinutes: 90 } as const;

/** The detach margin a handle keeps before the kill time, in minutes. */
const MARGIN_MINUTES = 5;

/** Rejects before anything spawns when the kill time leaves too little room for a round. */
export const checkRoom = (sandbox: Sandbox): void => {
  const now = DateTime.unsafeNow().epochMillis;
  const room = (sandbox.killTime.getTime() - now) / 60_000 - MARGIN_MINUTES;
  if (room < LIMITS.deadlineMinutes) {
    throw new RangeError(
      `implementSpec: the sandbox leaves ${Math.max(0, room).toFixed(1)} minutes before its detach deadline, but a round needs ${LIMITS.deadlineMinutes}. Create it with timeLimitMinutes: implementSpec.limits.timeLimitMinutes (${LIMITS.timeLimitMinutes}).`,
    );
  }
};

/** What every task start takes from the input. */
export const common = (input: ImplementSpecInput) => ({
  repo: input.repo,
  githubToken: input.githubToken,
  skillsContext: input.skillsContext,
  ...(input.setup === undefined ? {} : { setup: input.setup }),
  ...(input.record === undefined ? {} : { record: input.record }),
  ...(input.agent === undefined ? {} : { agent: input.agent }),
});

/** The end: no round left, and the result read from the state. */
export const finished = (state: ImplementSpecState): ImplementSpecStep => {
  const done = { ...state, sessions: {}, done: true };
  return { done: true, state: done, result: resultOf(done) };
};

/** An error's message, for a summary. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
