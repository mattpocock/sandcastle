/**
 * Sandcastle v1 (pre-release): one provider contract, `createSandbox`, and
 * agent sessions run by the session supervisor inside the sandbox.
 * Imported as `@ai-hero/sandcastle/v1` until v1 takes over the package root.
 *
 * @packageDocumentation
 */

export { createSandbox } from "./v1/createSandbox.js";
export { CreateSandboxError } from "./v1/CreateSandboxError.js";
export { ExecFailedError } from "./v1/ExecFailedError.js";
export type {
  CreateSandboxOptions,
  DetachableSandbox,
  DetachOptions,
  DetachReceipt,
  ExecOptions,
  ExecResult,
  RunningWork,
  Sandbox,
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
export type {
  ClaudeCodeOptions,
  CodexOptions,
  CopilotOptions,
  CursorOptions,
  OpenCodeOptions,
  PiOptions,
} from "./AgentProvider.js";
export { Output } from "./v1/Output.js";
export type {
  OutputDefinition,
  OutputObjectDefinition,
  OutputStringDefinition,
} from "./Output.js";
export type {
  AgentStreamEvent,
  OutputType,
  SessionContextWindow,
  SessionExitReason,
  SessionOptions,
  SessionProcess,
  SessionResult,
  SessionUsage,
} from "./v1/Session.js";
export { SessionFailedError } from "./v1/SessionFailedError.js";
export { StructuredOutputError } from "./v1/StructuredOutputError.js";
export { DetachError } from "./v1/DetachError.js";
export type { DetachErrorReason } from "./v1/DetachError.js";
export { SandboxDetachedError } from "./v1/SandboxDetachedError.js";
export { verifyFinishReport } from "./v1/verifyFinishReport.js";
export { FinishReportVerificationError } from "./v1/FinishReportVerificationError.js";
export type { FinishReportVerificationFailure } from "./v1/FinishReportVerificationError.js";
export type {
  FailedDetachedWork,
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
