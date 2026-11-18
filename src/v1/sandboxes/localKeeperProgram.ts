import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The keeper (localKeeperMain.ts) is built with the package as one
// self-contained file, dist/keeper.js. Built, this module sits in dist/ or
// a directory below it; run from source (the repo's own tests), it's
// src/v1/sandboxes/ and the program comes from the last build.
const CANDIDATES = [
  "./keeper.js",
  "../keeper.js",
  "../../keeper.js",
  "../../../dist/keeper.js",
];

/** The keeper program's path, for `node <path> <folder>`. */
export const keeperProgram = async (): Promise<string> => {
  const paths = CANDIDATES.map((candidate) =>
    fileURLToPath(new URL(candidate, import.meta.url)),
  );
  const found = await Promise.all(
    paths.map(async (path) =>
      access(path).then(
        () => path,
        () => undefined,
      ),
    ),
  );
  const program = found.find((path) => path !== undefined);
  if (program === undefined) {
    throw new Error(
      "The local sandbox keeper (keeper.js) is missing from the package. Reinstall @ai-hero/sandcastle; in its own repo, run `npm run build`.",
    );
  }
  return program;
};
