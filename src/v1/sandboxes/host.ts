/**
 * The host provider for Sandcastle v1 (pre-release): sandboxes that run on
 * this machine, as you, with no isolation. Imported as
 * `@ai-hero/sandcastle/v1/sandboxes/host`. Runs on Linux, macOS and
 * Windows, where it needs no `sh`.
 *
 * @packageDocumentation
 */

export { host } from "./hostProvider.js";
export type { HostCreateOptions, HostOptions } from "./hostProvider.js";
export type { HostNative } from "./hostSandbox.js";
