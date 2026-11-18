/**
 * The Podman sandbox provider for Sandcastle v1 (pre-release). Imported as
 * `@ai-hero/sandcastle/v1/sandboxes/podman`. Needs no npm package: only the
 * `podman` CLI on PATH (with a running `podman machine` on macOS and
 * Windows).
 *
 * @packageDocumentation
 */

export type { LinuxCapability } from "../../LinuxCapability.js";
export type { EngineContainer } from "./containerEngine.js";
export { podman } from "./podmanProvider.js";
export type { PodmanCreateOptions, PodmanOptions } from "./podmanProvider.js";
