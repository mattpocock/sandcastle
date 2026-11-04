/**
 * Sandcastle v1 (pre-release): one provider contract and `createSandbox`.
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
  ExecOptions,
  ExecResult,
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
