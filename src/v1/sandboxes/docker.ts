/**
 * The Docker sandbox provider for Sandcastle v1 (pre-release). Imported as
 * `@ai-hero/sandcastle/v1/sandboxes/docker`. Needs no npm package: only the
 * `docker` CLI on PATH, talking to a running engine (Docker Desktop on macOS
 * and Windows).
 *
 * @packageDocumentation
 */

export type { LinuxCapability } from "../../LinuxCapability.js";
export type { EngineContainer } from "./containerEngine.js";
export { docker } from "./dockerProvider.js";
export type { DockerCreateOptions, DockerOptions } from "./dockerProvider.js";
