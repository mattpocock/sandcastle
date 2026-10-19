import { createRequire } from "node:module";

const fallbackVersion = (): string => {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
};

/** Installed manifest version, including source-qualified fork candidates packed from a reviewed build. */
export const VERSION: string = fallbackVersion();
