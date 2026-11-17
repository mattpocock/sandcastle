// vercel(), the Vercel provider factory. Its entry point is ./vercel.ts.

import type { Sandbox as VercelSandbox } from "@vercel/sandbox";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import { resolveVercelAuth } from "./vercelAuth.js";
import type { VercelCreateOptions, VercelSdk } from "./vercelSandbox.js";
import {
  createVercelSandbox,
  getVercelSandbox,
  spawnInVercelSandbox,
} from "./vercelSandbox.js";

/** Options for `vercel()`. They stay on the host: none reach the sandbox. */
export interface VercelOptions {
  /**
   * Vercel access token. Default the `VERCEL_TOKEN` environment variable. A
   * token needs a team and project id too; with no token, `@vercel/sandbox`
   * uses Vercel's OIDC token (`VERCEL_OIDC_TOKEN`), as on a Vercel deployment
   * or after `vercel env pull`.
   */
  readonly token?: string;
  /** Vercel team id. Default the `VERCEL_TEAM_ID` environment variable. */
  readonly teamId?: string;
  /** Vercel project id. Default the `VERCEL_PROJECT_ID` environment variable. */
  readonly projectId?: string;
  /** Passed to `@vercel/sandbox`'s `Sandbox.create`: an image or source, resources, ports, a network policy, and anything else it takes. */
  readonly create?: VercelCreateOptions;
}

/**
 * A provider of Vercel sandboxes. Sandcastle creates each one with a timeout
 * of the sandbox's time limit (so its kill time is known, and a run nobody
 * hears back from can't bill forever) and with `persistent: false`, so
 * stopping it leaves no snapshot behind. Env reaches each command through
 * Vercel's own per-command env. `close()` stops the sandbox. Its sandboxes
 * are detachable: the session supervisor runs as a detached command. `native`
 * is `@vercel/sandbox`'s `Sandbox`.
 *
 * Vercel's Hobby plan caps a sandbox's timeout at 45 minutes, under
 * `createSandbox`'s default time limit of 60: pass `timeLimitMinutes`.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { vercel } from "@ai-hero/sandcastle/v1/sandboxes/vercel";
 *
 * await using sandbox = await createSandbox({
 *   provider: vercel({ create: { resources: { vcpus: 4 } } }),
 *   env: { GH_TOKEN: token },
 *   timeLimitMinutes: 45,
 * });
 * ```
 */
export const vercel = (
  options: VercelOptions = {},
): SandboxProvider<VercelSandbox, true> => {
  let sdk: Promise<VercelSdk> | undefined;
  const load = async (): Promise<VercelSdk> => {
    sdk ??= import("@vercel/sandbox").then(({ Sandbox }) => Sandbox);
    return sdk;
  };
  return createSandboxProvider({
    name: "vercel",
    create: async (createOptions) =>
      createVercelSandbox(
        await load(),
        { create: options.create, auth: resolveVercelAuth(options) },
        createOptions,
      ),
    detach: {
      spawnDetached: spawnInVercelSandbox,
      get: async (sandboxId) =>
        getVercelSandbox(await load(), resolveVercelAuth(options), sandboxId),
    },
  });
};
