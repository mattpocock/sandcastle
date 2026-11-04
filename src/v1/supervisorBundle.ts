import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The session supervisor is built with the package as one self-contained
// file, dist/supervisor.js. Built, this module sits in dist/ or a directory
// below it; run from source (the repo's own tests), it's src/v1/ and the
// bundle comes from the last build.
const CANDIDATES = [
  "./supervisor.js",
  "../supervisor.js",
  "../../dist/supervisor.js",
];

let cached: Promise<string> | undefined;

const firstReadable = async (): Promise<string> => {
  const texts = await Promise.all(
    CANDIDATES.map(async (candidate) =>
      readFile(
        fileURLToPath(new URL(candidate, import.meta.url)),
        "utf8",
      ).catch(() => undefined),
    ),
  );
  const text = texts.find((found) => found !== undefined);
  if (text === undefined) {
    throw new Error(
      "The session supervisor bundle (supervisor.js) is missing from the package. Reinstall @ai-hero/sandcastle; in its own repo, run `npm run build`.",
    );
  }
  return text;
};

/** The supervisor bundle's text, read once. */
export const supervisorBundle = (): Promise<string> => {
  cached ??= firstReadable().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
};
