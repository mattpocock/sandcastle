/**
 * The Seatbelt sandbox provider for Sandcastle v1 (pre-release), for macOS
 * 14 or later. Imported as `@ai-hero/sandcastle/v1/sandboxes/seatbelt`.
 * Needs nothing installed beyond the toolchain: it runs the system
 * `/usr/bin/sandbox-exec`.
 *
 * @packageDocumentation
 */

export { seatbelt } from "./seatbeltProvider.js";
export type {
  SeatbeltCreateOptions,
  SeatbeltOptions,
} from "./seatbeltProvider.js";
export type { SeatbeltNative } from "./seatbeltSandbox.js";
