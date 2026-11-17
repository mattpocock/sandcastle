// e2b(), the E2B provider factory. Its entry point is ./e2b.ts.

import type { Sandbox as E2BSandbox } from "e2b";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { E2BConnection, E2BCreateOptions } from "./e2bSandbox.js";
import {
  createE2BSandbox,
  getE2BSandbox,
  spawnInE2BSandbox,
} from "./e2bSandbox.js";

/** Options for `e2b()`. They stay on the host: none reach the sandbox. */
export interface E2BOptions {
  /** E2B API key. Default the `E2B_API_KEY` environment variable; an empty value counts as unset. */
  readonly apiKey?: string;
  /** E2B domain. Default the `E2B_DOMAIN` environment variable, else E2B's own (`e2b.app`). */
  readonly domain?: string;
  /**
   * Passed to `e2b`'s `Sandbox.create`: a template, metadata, network rules,
   * and anything else it takes. The template defaults to E2B's `claude`,
   * which has Node.js and Claude Code.
   */
  readonly create?: E2BCreateOptions;
}

/** The connection options that are set: an empty one counts as unset, so the SDK reads its env var. */
const connectionOf = (options: E2BOptions): E2BConnection => {
  const entries = Object.entries({
    apiKey: options.apiKey,
    domain: options.domain,
  }).filter(([, value]) => value !== undefined && value !== "");
  return Object.fromEntries(entries);
};

/** `e2b`'s `Sandbox` class, loaded only when a sandbox is made or found. */
const sdk = async () => {
  const { Sandbox } = await import("e2b");
  return Sandbox;
};

/**
 * A provider of E2B sandboxes. Sandcastle creates each one from E2B's
 * `claude` template unless `create` names another, with a timeout of the
 * sandbox's time limit and killed (never paused) when it runs out, so its
 * kill time is known and a run nobody hears back from can't bill forever.
 * The kill time is read back from E2B. Env reaches each command through
 * E2B's own per-command env, never the sandbox's. `close()` kills the
 * sandbox. Its sandboxes are detachable: the session supervisor runs as a
 * background command the host disconnects from. `native` is `e2b`'s
 * `Sandbox`.
 *
 * E2B's plan caps a sandbox's life (1 hour on Hobby, 24 hours on Pro), so a
 * longer `timeLimitMinutes` fails at create with E2B's own message.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { e2b } from "@ai-hero/sandcastle/v1/sandboxes/e2b";
 *
 * await using sandbox = await createSandbox({
 *   provider: e2b({ create: { metadata: { run: "r-1" } } }),
 *   env: { GH_TOKEN: token },
 *   timeLimitMinutes: 60,
 * });
 * ```
 */
export const e2b = (
  options: E2BOptions = {},
): SandboxProvider<E2BSandbox, true> => {
  const connection = connectionOf(options);
  return createSandboxProvider({
    name: "e2b",
    create: async (createOptions) =>
      createE2BSandbox(await sdk(), {
        connection,
        create: options.create,
        options: createOptions,
      }),
    detach: {
      spawnDetached: spawnInE2BSandbox,
      get: async (sandboxId) =>
        getE2BSandbox(await sdk(), connection, sandboxId),
    },
  });
};
