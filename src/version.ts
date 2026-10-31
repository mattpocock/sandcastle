import { createRequire } from "node:module";

declare const __SANDCASTLE_VERSION__: string | undefined;

const fallbackVersion = (): string => {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
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
