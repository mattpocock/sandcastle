/**
 * Sandcastle's bundled tasks (pre-release, expect the API to change).
 * Imported as `@ai-hero/sandcastle/v1/tasks`. Each task has `start(sandbox,
 * input)`, which sets the repo up and resolves once its one session runs,
 * `outputs` for `verifyFinishReport`, and `limits`, its own time-limit
 * assumptions. The types they take and return are re-exported here too;
 * they're the same ones `@ai-hero/sandcastle/v1` exports.
 *
 * A chooser picks which of a spec's tickets to build next: `sessionChooser()`
 * (a short session on Haiku), `jevChooser()` (TypeSafe's Jev decision model,
 * optional), or any function of the `Chooser` type.
 *
 * @packageDocumentation
 */

export type { Choice, Chooser, ChooserContext } from "./chooser.js";
export type { SpecTicket, SpecTickets } from "./chooserGithubTickets.js";
export { jevChooser } from "./chooserJev.js";
export type { JevChooserOptions } from "./chooserJev.js";
export { sessionChooser } from "./chooserSession.js";
export type { SessionChooserOptions } from "./chooserSession.js";
export { general } from "./taskGeneral.js";
export type {
  GeneralInput,
  GeneralOutputs,
  GeneralTask,
} from "./taskGeneral.js";
export type {
  ImplementOutputs,
  ImplementResult,
} from "./implementResult.js";
export { implement } from "./taskImplement.js";
export type {
  ImplementCommon,
  ImplementInput,
  ImplementRound,
  ImplementTask,
  ImplementWork,
} from "./taskImplement.js";
export { review } from "./taskReview.js";
export type { ReviewInput, ReviewTask } from "./taskReview.js";
export type { ReviewOutputs, ReviewResult } from "./taskReviewResult.js";
export type {
  TaskAgentOptions,
  TaskLimits,
  TaskSkillsContext,
  Tracker,
} from "./Task.js";
export type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "./Output.js";
export type { OutputMap } from "./FinishReport.js";
export type { ExecOptions, ExecResult, Sandbox } from "./Sandbox.js";
export type { AgentName, AgentProvider } from "./agents.js";
export type {
  AgentStreamEvent,
  OutputType,
  SessionContextWindow,
  SessionExitReason,
  SessionOptions,
  SessionProcess,
  SessionResult,
  SessionUsage,
} from "./Session.js";
export type {
  NativeSessionFile,
  NativeSessionFormat,
  RecordedEvent,
  RecordRedaction,
  SessionRecord,
  SessionRecordOptions,
} from "./SessionRecord.js";
