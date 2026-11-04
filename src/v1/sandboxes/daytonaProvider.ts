// daytona(), the Daytona provider factory. Its entry point is ./daytona.ts.

import type {
  Daytona as DaytonaClient,
  Sandbox as DaytonaSandbox,
} from "@daytona/sdk";
import type { SandboxProvider } from "../SandboxProvider.js";
import { createSandboxProvider } from "../SandboxProvider.js";
import type { DaytonaCreateOptions } from "./daytonaSandbox.js";
import {
  createDaytonaSandbox,
  getDaytonaSandbox,
  spawnInDaytonaSandbox,
} from "./daytonaSandbox.js";

/** Options for `daytona()`. They stay on the host: none reach the sandbox. */
export interface DaytonaOptions {
  /** Daytona API key. Default the `DAYTONA_API_KEY` environment variable. */
  readonly apiKey?: string;
  /** Daytona API URL. Default the `DAYTONA_API_URL` environment variable, else Daytona's own. */
  readonly apiUrl?: string;
  /** Where sandboxes run. Default the `DAYTONA_TARGET` environment variable, else Daytona's own. */
  readonly target?: string;
  /** Passed to `@daytona/sdk`'s create: a snapshot or an image, and anything else it takes. */
  readonly create?: DaytonaCreateOptions;
}

/** The Daytona client config: only the connection options that are set. */
const clientConfig = (
  options: DaytonaOptions,
): { apiKey?: string; apiUrl?: string; target?: string } => {
  const entries = Object.entries({
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    target: options.target,
  }).filter(([, value]) => value !== undefined && value !== "");
  return Object.fromEntries(entries);
};

/**
 * A provider of Daytona sandboxes. Sandcastle creates each one with auto-stop
 * off and a TTL of the sandbox's time limit, so its kill time is known and a
 * run nobody hears back from can't bill forever. Env reaches each command
 * through a file that is removed as the command starts. `close()` deletes the
 * sandbox. Its sandboxes are detachable: the session supervisor runs in a
 * Daytona session the host never ends. `native` is `@daytona/sdk`'s
 * `Sandbox`.
 *
 * @example
 * ```ts
 * import { createSandbox } from "@ai-hero/sandcastle/v1";
 * import { daytona } from "@ai-hero/sandcastle/v1/sandboxes/daytona";
 *
 * await using sandbox = await createSandbox({
 *   provider: daytona({ create: { snapshot: "my-snapshot" } }),
 *   env: { GH_TOKEN: token },
 *   timeLimitMinutes: 60,
 * });
 * ```
 */
export const daytona = (
  options: DaytonaOptions = {},
): SandboxProvider<DaytonaSandbox, true> => {
  let client: Promise<DaytonaClient> | undefined;
  const connect = async (): Promise<DaytonaClient> => {
    client ??= import("@daytona/sdk").then(
      ({ Daytona }) => new Daytona(clientConfig(options)),
    );
    return client;
  };
  return createSandboxProvider({
    name: "daytona",
    create: async (createOptions) =>
      createDaytonaSandbox(await connect(), options.create, createOptions),
    detach: {
      spawnDetached: spawnInDaytonaSandbox,
      get: async (sandboxId) => getDaytonaSandbox(await connect(), sandboxId),
    },
  });
};
