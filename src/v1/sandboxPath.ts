import { posix, win32 } from "node:path";

// Paths inside a sandbox. A sandbox's paths are POSIX, except a sandbox that
// is a host directory on Windows, whose paths are Windows paths: each is
// handled in the flavour of the absolute path it starts from.

/** The path flavour of a sandbox whose paths include the absolute `reference`. */
export const sandboxPaths = (reference: string): typeof posix =>
  win32.isAbsolute(reference) && !posix.isAbsolute(reference) ? win32 : posix;

/** `path` resolved against `workingDirectory`; an absolute `path` stays as it is. */
export const resolveInSandbox = (
  workingDirectory: string,
  path: string,
): string => sandboxPaths(workingDirectory).resolve(workingDirectory, path);

/** `parts` joined onto the absolute `directory`, in its flavour. */
export const joinInSandbox = (directory: string, ...parts: string[]): string =>
  sandboxPaths(directory).join(directory, ...parts);
