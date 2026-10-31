import { createRequire } from "node:module";

declare const __SANDCASTLE_VERSION__: string | undefined;

const fallbackVersion = (): string => {
  const require = createRequire(import.meta.url);
  const pkg: unknown = require("../package.json");
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
  ) {
    return pkg.version;
  }
  throw new Error("Could not read the version from package.json.");
};

/**
 * The package version. Injected at build time by tsup via `define`. When
 * the source is loaded directly (e.g. via `tsx` during tests) the constant
 * is undefined, so we fall back to reading `package.json` at runtime.
 */
export const VERSION: string =
  typeof __SANDCASTLE_VERSION__ === "undefined"
    ? fallbackVersion()
    : __SANDCASTLE_VERSION__;
