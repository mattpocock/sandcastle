/**
 * Sandcastle's bundled tasks (pre-release, expect the API to change).
 * Imported as `@ai-hero/sandcastle/v1/tasks`. Each task has `start(sandbox,
 * input)`, which sets the repo up and resolves once its one session runs,
 * `outputs` for `verifyFinishReport`, and `limits`, its own time-limit
 * assumptions. The types they take and return (`Sandbox`, `SessionProcess`,
 * `OutputDefinition`, `OutputMap`) come from `@ai-hero/sandcastle/v1`.
 *
 * @packageDocumentation
 */

export { general } from "./taskGeneral.js";
export type {
  GeneralInput,
  GeneralOutputs,
  GeneralTask,
} from "./taskGeneral.js";
export { review } from "./taskReview.js";
export type { ReviewInput, ReviewTask } from "./taskReview.js";
export type { ReviewOutputs, ReviewResult } from "./taskReviewResult.js";
export type { TaskLimits, TaskSkillsContext, Tracker } from "./Task.js";
