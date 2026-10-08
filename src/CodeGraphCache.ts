import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const codeGraphCacheKey = (branch: string): string => {
  const segments = branch.split("/");
  if (
    !branch ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid CodeGraph branch: ${branch}`);
  }

  return branch.replaceAll("/", "--");
};

/**
 * Return a stable CodeGraph cache directory for a branch, seeding its database
 * once from the base-branch index when one is available.
 */
export const prepareCodeGraphCache = (options: {
  readonly cacheRoot: string;
  readonly branch: string;
  readonly seedDatabase: string;
}): string => {
  const cacheDirectory = join(
    options.cacheRoot,
    codeGraphCacheKey(options.branch),
  );
  const cacheDatabase = join(cacheDirectory, "codegraph.db");
  const cacheIgnoreFile = join(cacheDirectory, ".gitignore");

  mkdirSync(cacheDirectory, { recursive: true });
  if (!existsSync(cacheIgnoreFile)) {
    writeFileSync(cacheIgnoreFile, "*\n");
  }
  if (!existsSync(cacheDatabase) && existsSync(options.seedDatabase)) {
    copyFileSync(
      options.seedDatabase,
      cacheDatabase,
      fsConstants.COPYFILE_FICLONE,
    );
  }

  return cacheDirectory;
};
