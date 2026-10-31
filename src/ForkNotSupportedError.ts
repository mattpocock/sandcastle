/**
 * Thrown by `.fork()` (and by any run given `forkSession`) when the **agent
 * provider** can resume a session but its CLI has no native fork. It is thrown
 * before any sandbox starts. Use `.resume()` instead, which continues the
 * session in place.
 *
 * Public-facing shape of the internal `ForkNotSupportedError` in `errors.ts`,
 * declared here so Effect's types stay out of the published `.d.ts` files.
 * Match it on `_tag` (or `name`), both `"ForkNotSupportedError"`.
 */
export interface ForkNotSupportedError extends Error {
  readonly _tag: "ForkNotSupportedError";
  readonly name: "ForkNotSupportedError";
  /** The agent provider's name, e.g. `"copilot"`. */
  readonly agentProvider: string;
}
