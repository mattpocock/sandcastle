import { NativeSandboxUnavailableError as NativeSandboxUnavailableErrorImpl } from "./errors.js";

/**
 * A native sandbox provider (`bwrap()`, `seatbelt()`) can't run on this host:
 * the wrong OS, its tool isn't installed, or the kernel blocks it. Thrown when
 * the provider is constructed, before any worktree exists, so a run never
 * falls back to running unsandboxed.
 *
 * Public-facing type for `NativeSandboxUnavailableError`. The runtime class is
 * the same `Data.TaggedError` from `errors.ts`, re-declared here as a plain
 * `Error` subclass so that Effect's types stay out of Sandcastle's published
 * `.d.ts` files.
 */
export interface NativeSandboxUnavailableError extends Error {
  readonly _tag: "NativeSandboxUnavailableError";
  readonly message: string;
  /** A shell command that fixes the host, when there is one (e.g. an install command). */
  readonly fixCommand?: string;
}

interface NativeSandboxUnavailableErrorConstructor {
  new (args: {
    readonly message: string;
    readonly fixCommand?: string;
  }): NativeSandboxUnavailableError;
  readonly prototype: NativeSandboxUnavailableError;
}

/** A native sandbox provider can't run on this host. */
export const NativeSandboxUnavailableError: NativeSandboxUnavailableErrorConstructor =
  NativeSandboxUnavailableErrorImpl;
