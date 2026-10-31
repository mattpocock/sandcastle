import { CwdError as CwdErrorImpl } from "./resolveCwd.js";

/**
 * The provided `cwd` path does not exist or is not a directory.
 *
 * Public-facing type for `CwdError`. The runtime class is the same
 * `Data.TaggedError` from `resolveCwd.ts`, but we re-declare its public
 * shape here as a plain `Error` subclass so that Effect's type machinery
 * does not leak into Sandcastle's published `.d.ts` files.
 */
export interface CwdError extends Error {
  readonly _tag: "CwdError";
  readonly message: string;
  readonly cwd: string;
}

interface CwdErrorConstructor {
  new (args: { readonly message: string; readonly cwd: string }): CwdError;
  readonly prototype: CwdError;
}

/** The provided `cwd` path does not exist or is not a directory. */
export const CwdError: CwdErrorConstructor = CwdErrorImpl;
