import type { FinishReport, OutputObjectDefinition, Sandbox } from "../v1.js";
import type { ImplementResult } from "./implementResult.js";
import {
  integrationBranchName,
  pushIntegrationBranch,
} from "./implementSpecBranch.js";
import {
  heldOutcomes,
  reportOutcomes,
  roundOutputs,
} from "./implementSpecOutcomes.js";
import { applyOutcomes } from "./implementSpecProgress.js";
import { advance, checkRoom, LIMITS } from "./implementSpecRounds.js";
import type {
  ImplementSpecInput,
  ImplementSpecResult,
  ImplementSpecState,
  ImplementSpecStep,
} from "./implementSpecTypes.js";
import type { TaskLimits } from "./Task.js";
import type { MergeResult } from "./taskMergeResult.js";

// `implementSpec`: a whole spec built ticket by ticket, in rounds on one
// sandbox. Written only against the public API: the handle, the chooser,
// `implement`, `merge` and `exec`.

/** `implementSpec.outputs(state)`: the round's `Output` definitions, by session name. */
export type ImplementSpecOutputs = Readonly<
  Record<
    string,
    | OutputObjectDefinition<ImplementResult>
    | OutputObjectDefinition<MergeResult>
  >
>;

/** What `implementSpec.next` takes. */
export interface ImplementSpecNext {
  /** The same input `start` took, with a fresh token if you like. */
  readonly input: ImplementSpecInput;
  /** The state the last step returned, as stored. */
  readonly state: ImplementSpecState;
  /** The last round's finish report, verified with `implementSpec.outputs(state)`. */
  readonly report: FinishReport;
}

/** The `implementSpec` bundled task: a spec's tickets built, each merged into one integration branch. */
export interface ImplementSpecTask {
  readonly name: "implementSpec";
  /**
   * 480 minutes for the sandbox's whole life across rounds, and 90 for each
   * round. `start` and `next` reject before spawning anything when the kill
   * time leaves less than a round.
   */
  readonly limits: TaskLimits;
  /**
   * Clones `repo`, then creates and pushes the integration branch
   * `sandcastle/implement-spec-<spec>-<random>` from the default branch. Runs
   * the chooser and spawns the first round: one `implement` session named
   * `implement-<ticket>` per chosen ticket (at most `maxConcurrent`), each in
   * its own clone, on a new branch from the integration branch, opening its
   * PR against it. Resolves with the round's sessions and the `state`, or
   * `done` when the chooser chose nothing.
   */
  readonly start: (
    sandbox: Sandbox,
    input: ImplementSpecInput,
  ) => Promise<ImplementSpecStep>;
  /**
   * Acts on the last round's report and spawns the next round. A ticket
   * whose PR opened or updated gets a `merge` session named `merge-<ticket>`
   * into the integration branch, one merge per round; `no-changes` counts as
   * merged. A `blocked` ticket, a failed merge or a failed session leaves
   * the ticket stuck, and the chooser skips what it blocks; a session the
   * deadline stopped is retried once, as `<step>-<ticket>-retry`. With no
   * merge waiting, the chooser runs and the next ticket round spawns. When
   * it chooses nothing, resolves `done` with the result.
   */
  readonly next: (
    sandbox: Sandbox,
    options: ImplementSpecNext,
  ) => Promise<ImplementSpecStep>;
  /** The `Output` definitions of the round `state` spawned, by session name, for `verifyFinishReport`. */
  readonly outputs: (state: ImplementSpecState) => ImplementSpecOutputs;
  /** Every round in turn on a held handle, with no detach; resolves with the result. */
  readonly run: (
    sandbox: Sandbox,
    input: ImplementSpecInput,
  ) => Promise<ImplementSpecResult>;
}

/** Rejects an input `start` and `next` can't work with, before anything runs. */
const checkInput = (input: ImplementSpecInput): void => {
  const { maxConcurrent } = input;
  if (
    maxConcurrent !== undefined &&
    (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
  ) {
    throw new RangeError(
      `implementSpec: maxConcurrent must be a positive whole number, not ${maxConcurrent}`,
    );
  }
  if (input.spec.trim() === "") {
    throw new TypeError("implementSpec: spec is required");
  }
};

const start: ImplementSpecTask["start"] = async (sandbox, input) => {
  checkInput(input);
  checkRoom(sandbox);
  const branch = integrationBranchName(input.spec);
  await pushIntegrationBranch(sandbox, {
    repo: input.repo,
    branch,
    githubToken: input.githubToken,
  });
  return advance(sandbox, input, {
    spec: input.spec,
    branch,
    round: 0,
    choices: 0,
    sessions: {},
    tickets: {},
    merges: [],
    done: false,
  });
};

const next: ImplementSpecTask["next"] = async (
  sandbox,
  { input, state, report },
) => {
  checkInput(input);
  if (state.done) {
    throw new TypeError(
      "implementSpec: the spec is done; there's no next round",
    );
  }
  const outcomes = await reportOutcomes(state, report);
  return advance(sandbox, input, applyOutcomes(state, outcomes));
};

const run: ImplementSpecTask["run"] = async (sandbox, input) => {
  const loop = async (
    step: ImplementSpecStep,
  ): Promise<ImplementSpecResult> => {
    if (step.done) {
      return step.result;
    }
    const outcomes = await heldOutcomes(step.sessions);
    return loop(
      await advance(sandbox, input, applyOutcomes(step.state, outcomes)),
    );
  };
  return loop(await start(sandbox, input));
};

/** Builds a spec's tickets in rounds on one sandbox and merges each into an integration branch; never into the default branch. */
export const implementSpec: ImplementSpecTask = {
  name: "implementSpec",
  limits: LIMITS,
  start,
  next,
  outputs: roundOutputs,
  run,
};
