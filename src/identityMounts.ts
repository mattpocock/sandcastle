/**
 * Identity mounts: the `mounts` option of the native sandbox providers, where
 * every path appears inside the sandbox at its own host path. Provider-agnostic:
 * shared by the native sandbox providers.
 */

import type { MountConfig } from "./MountConfig.js";
import { resolveUserMounts } from "./mountUtils.js";

export type { MountConfig } from "./MountConfig.js";

/** A resolved mount that appears at its own host path. */
export interface IdentityMount {
  readonly hostPath: string;
  readonly readonly: boolean;
}

/**
 * Resolves `mounts` (tilde and relative paths, as for every provider) and
 * checks each appears at its own host path. Throws, naming `provider`, when a
 * resolved `sandboxPath` differs from its resolved `hostPath`, or when a
 * `hostPath` doesn't exist.
 */
export const resolveIdentityMounts = (
  provider: string,
  mounts: readonly MountConfig[],
  sandboxHomedir: string,
): IdentityMount[] =>
  resolveUserMounts(mounts, sandboxHomedir).map((resolved, i) => {
    if (resolved.sandboxPath !== resolved.hostPath) {
      const given = mounts[i];
      throw new Error(
        `${provider}() mounts appear at their host path, so sandboxPath must equal hostPath: ` +
          `got hostPath ${given?.hostPath ?? resolved.hostPath} (resolved to ${resolved.hostPath}) ` +
          `and sandboxPath ${given?.sandboxPath ?? resolved.sandboxPath} (resolved to ${resolved.sandboxPath}).`,
      );
    }
    return {
      hostPath: resolved.hostPath,
      readonly: resolved.readonly === true,
    };
  });
