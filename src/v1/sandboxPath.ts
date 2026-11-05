import { posix, win32 } from "node:path";

// Paths inside a sandbox. A sandbox's paths are POSIX, except a sandbox that
// is a host directory on Windows (the fake's), whose working directory is a
// Windows path: each is resolved in the flavour of its working directory.

/** `path` resolved against `workingDirectory`; an absolute `path` stays as it is. */
export const resolveInSandbox = (
  workingDirectory: string,
  path: string,
): string => {
  const flavour =
    win32.isAbsolute(workingDirectory) && !posix.isAbsolute(workingDirectory)
      ? win32
      : posix;
  return flavour.resolve(workingDirectory, path);
};
