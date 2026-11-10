/**
 * Sandcastle v1 (pre-release): one provider contract, `createSandbox`, and
 * agent sessions run by the session supervisor inside the sandbox.
 * Imported as `@ai-hero/sandcastle/v1` until v1 takes over the package root.
 *
 * @packageDocumentation
 */

export { createSandbox } from "./v1/createSandbox.js";
export { reattachSandbox } from "./v1/reattachSandbox.js";
export { SandboxUnavailableError } from "./v1/SandboxUnavailableError.js";
export { CreateSandboxError } from "./v1/CreateSandboxError.js";
export { ExecFailedError } from "./v1/ExecFailedError.js";
export type {
  CreateSandboxOptions,
  DetachableSandbox,
  DetachOptions,
  DetachReceipt,
  EndedWork,
  ExecOptions,
  ExecResult,
  FinishReportDelivery,
  FollowOptions,
  ReattachSandboxOptions,
  RunningWork,
  Sandbox,
  SandboxStatus,
  StatusOptions,
} from "./v1/Sandbox.js";
export { createSandboxProvider } from "./v1/SandboxProvider.js";
export type {
  DetachCapability,
  ProviderCreateOptions,
  ProviderExecOptions,
  ProviderExecResult,
  ProviderSandbox,
  SandboxProvider,
  SandboxProviderConfig,
} from "./v1/SandboxProvider.js";
export {
  claudeCode,
  codex,
  copilot,
  cursor,
  opencode,
  pi,
} from "./v1/agents.js";
export type {
  AgentName,
  AgentProvider,
  ClaudeCodeAgentOptions,
  CodexAgentOptions,
  CopilotAgentOptions,
  CursorAgentOptions,
  OpenCodeAgentOptions,
  PiAgentOptions,
} from "./v1/agents.js";
export { Output } from "./v1/Output.js";
export type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "./v1/Output.js";
export type {
  AgentStreamEvent,
  OutputType,
  SendOptions,
  SendReceipt,
  SessionContextWindow,
  SessionExitReason,
  SessionOptions,
  SessionProcess,
  SessionResult,
  SessionSendOptions,
  SessionUsage,
} from "./v1/Session.js";
export { SessionFailedError } from "./v1/SessionFailedError.js";
export { SessionInputError } from "./v1/SessionInputError.js";
export type { SessionInputErrorReason } from "./v1/SessionInputError.js";
export { StructuredOutputError } from "./v1/StructuredOutputError.js";
export { DetachError } from "./v1/DetachError.js";
export type { DetachErrorReason } from "./v1/DetachError.js";
export { SandboxDetachedError } from "./v1/SandboxDetachedError.js";
export { verifyFinishReport } from "./v1/verifyFinishReport.js";
export { FinishReportVerificationError } from "./v1/FinishReportVerificationError.js";
export type { FinishReportVerificationFailure } from "./v1/FinishReportVerificationError.js";
export type {
  DetachedWorkBase,
  FailedDetachedWork,
  FailedSessionReports,
  FailureReason,
  FinishReport,
  FinishReportDestination,
  OutputMap,
  ProcessReport,
  SessionReport,
  SessionReports,
  SucceededDetachedWork,
  VerifyFinishReportOptions,
} from "./v1/FinishReport.js";
export type {
  NativeSessionFile,
  NativeSessionFormat,
  RecordDeliveryStatus,
  RecordedEvent,
  RecordRedaction,
  SessionRecord,
  SessionRecordOptions,
  SessionRecordPointer,
} from "./v1/SessionRecord.js";
