/**
 * How sync-out refuses a path, and the path facts every check shares. See
 * `syncOutPaths.ts`.
 */

import { posix, win32 } from "node:path";
import { SyncOutPathError } from "./errors.js";

/** A refusal to sync `path` out, saying why. */
export const refusal = (path: string, reason: string): SyncOutPathError =>
  new SyncOutPathError({
    message: `Refusing to sync ${JSON.stringify(path)} out of the sandbox: ${reason}`,
    path,
  });

/** `.git`, including the spellings Windows treats as the same name. */
export const isGitSegment = (segment: string): boolean =>
  segment.toLowerCase().replace(/[. ]+$/u, "") === ".git";

/** Absolute on any platform: `/x`, `\x`, `C:x`, `\\server\x`. */
export const isAbsoluteAnywhere = (p: string): boolean =>
  posix.isAbsolute(p) || win32.isAbsolute(p) || /^[a-z]:/iu.test(p);
