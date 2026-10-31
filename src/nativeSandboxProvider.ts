/**
 * Native sandbox providers: bind-mount sandbox providers that contain the
 * agent with the host OS's own process sandbox (Bubblewrap, Seatbelt) instead
 * of a container. They share the "bind-mount" tag, so core knows them by a
 * mark set when the provider is constructed.
 */

import { NativeInteractiveNotSupportedError as NativeInteractiveNotSupportedErrorImpl } from "./errors.js";
import type { SandboxProvider } from "./SandboxProvider.js";

const nativeProviders = new WeakSet<SandboxProvider>();

/** Marks `provider` as a native sandbox provider, and returns it. */
export const markNativeSandboxProvider = <P extends SandboxProvider>(
  provider: P,
): P => {
  nativeProviders.add(provider);
  return provider;
};

/**
 * `interactive()` was called with a native sandbox provider (`bwrap()`,
 * `seatbelt()`). Native providers don't run interactive sessions: use `run()`,
 * or pass `docker()` or `noSandbox()` to `interactive()`.
 *
 * Public-facing type for `NativeInteractiveNotSupportedError`. The runtime
 * class is the same `Data.TaggedError` from `errors.ts`, re-declared here as a
 * plain `Error` subclass so that Effect's types stay out of Sandcastle's
 * published `.d.ts` files.
 */
export interface NativeInteractiveNotSupportedError extends Error {
  readonly _tag: "NativeInteractiveNotSupportedError";
  readonly message: string;
  /** The native sandbox provider `interactive()` was called with. */
  readonly provider: string;
}

interface NativeInteractiveNotSupportedErrorConstructor {
  new (args: {
    readonly message: string;
    readonly provider: string;
  }): NativeInteractiveNotSupportedError;
  readonly prototype: NativeInteractiveNotSupportedError;
}

/** `interactive()` was called with a native sandbox provider. */
export const NativeInteractiveNotSupportedError: NativeInteractiveNotSupportedErrorConstructor =
  NativeInteractiveNotSupportedErrorImpl;

/** Throws `NativeInteractiveNotSupportedError` when `provider` is a native sandbox provider. */
export const assertInteractiveSupported = (
  provider: SandboxProvider | undefined,
): void => {
  if (provider !== undefined && nativeProviders.has(provider)) {
    throw new NativeInteractiveNotSupportedError({
      message:
        `interactive() is not supported on native providers (got ${provider.name}()). ` +
        `Use run(), or pass docker() or noSandbox() to interactive().`,
      provider: provider.name,
    });
  }
};
