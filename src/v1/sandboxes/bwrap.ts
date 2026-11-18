/**
 * The Bubblewrap sandbox provider for Sandcastle v1 (pre-release), for
 * Linux and WSL2. Imported as `@ai-hero/sandcastle/v1/sandboxes/bwrap`.
 * Needs `bwrap` (Bubblewrap) on the host.
 *
 * @packageDocumentation
 */

export { bwrap } from "./bwrapProvider.js";
export type { BwrapCreateOptions, BwrapOptions } from "./bwrapProvider.js";
export type { BwrapNative } from "./bwrapSandbox.js";
