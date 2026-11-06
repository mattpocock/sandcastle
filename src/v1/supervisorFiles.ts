import type { DetachableSandbox } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import { followSession } from "./sessionFollow.js";
import { sendTo } from "./sessionSend.js";
import { readStatus } from "./sandboxStatus.js";
import type { SupervisorLink } from "./supervisorHost.js";

// What a detachable handle does without holding anything, so it works after
// a detach and on a reattached handle: read its session supervisor's files
// through the provider, no live supervisor needed (ADR 0030, ADR 0031), and
// hand a running session a message through the supervisor (ADR 0032).

/** `status()`, `follow()` and `send()` for a sandbox whose supervisor is `link`. */
export const supervisorFiles = (
  sandbox: ProviderSandbox,
  link: SupervisorLink,
): Pick<DetachableSandbox, "status" | "follow" | "send"> => ({
  status: async (options) => readStatus(sandbox, link.directory, options),
  follow: (options) => followSession(sandbox, link.directory, options),
  send: async (options) =>
    sendTo(
      link,
      options.session === undefined ? {} : { name: options.session },
      options,
    ),
});
