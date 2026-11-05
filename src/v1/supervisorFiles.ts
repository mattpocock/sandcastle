import type { FollowOptions, SandboxStatus, StatusOptions } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import type { RecordedEvent } from "./SessionRecord.js";
import { followSession } from "./sessionFollow.js";
import { readStatus } from "./sandboxStatus.js";

// What a detachable handle reads from its session supervisor's files through
// the provider: no live supervisor needed, so these work after a detach and
// on a reattached handle (ADR 0030, ADR 0031).

/** `status()` and `follow()` for a sandbox whose supervisor lives in `directory`. */
export const supervisorFiles = (
  sandbox: ProviderSandbox,
  directory: string,
): {
  readonly status: (options?: StatusOptions) => Promise<SandboxStatus>;
  readonly follow: (options?: FollowOptions) => AsyncIterable<RecordedEvent>;
} => ({
  status: async (options) => readStatus(sandbox, directory, options),
  follow: (options) => followSession(sandbox, directory, options),
});
