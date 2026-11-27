/**
 * The node fs calls `protectGitMounts.ts` makes, as Effects that never fail:
 * any error becomes `None`, as missing git metadata is skipped there.
 */

import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs";
import { Effect, Option } from "effect";

/** A node fs call as an Effect; any error becomes `None`. */
const attempt = <A>(
  call: (done: (error: Error | null, value: A) => void) => void,
): Effect.Effect<Option.Option<A>> =>
  Effect.async((resume) => {
    call((error, value) => {
      resume(
        Effect.succeed(error === null ? Option.some(value) : Option.none()),
      );
    });
  });

/** `realpath`. */
export const realPath = (p: string) =>
  attempt<string>((done) => {
    realpath(p, done);
  });

/** A UTF-8 file's text. */
export const readText = (p: string) =>
  attempt<string>((done) => {
    readFile(p, "utf8", done);
  });

/** `lstat`: a symlink is not followed. */
export const statOf = (p: string) =>
  attempt<Stats>((done) => {
    lstat(p, done);
  });

/** `mkdir -p`. */
export const ensureDir = (p: string) =>
  attempt<string | undefined>((done) => {
    mkdir(p, { recursive: true }, done);
  });

/** A dir's entry names. */
export const listDir = (p: string) =>
  attempt<string[]>((done) => {
    readdir(p, done);
  });

/**
 * Creates `p` empty if nothing is there. Anything already there, a symlink
 * included, is left as it is (`wx` neither follows nor truncates).
 */
export const ensureFile = (p: string) =>
  attempt<undefined>((done) => {
    writeFile(p, "", { flag: "wx" }, (error) => {
      done(error, undefined);
    });
  });
