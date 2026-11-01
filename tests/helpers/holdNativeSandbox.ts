/**
 * A host process that holds a native sandbox open, for the containment
 * suite's hard-kill probe. Run as a separate Node process (see
 * {@link spawnSandboxHolder}): it opens a sandbox with the named provider in
 * the repo given, starts `sleep <seconds>` in it, prints `ready`, and waits
 * to be killed. Nothing here closes the sandbox, so only the provider's own
 * defences can stop the sleep outliving this process.
 *
 *   node --import tsx tests/helpers/holdNativeSandbox.ts <provider> <repo> <seconds>
 */

import { createSandbox } from "@ai-hero/sandcastle";
import { NATIVE_PROVIDERS } from "./nativeProviders.js";

const [providerName, repo, seconds] = process.argv.slice(2);
const provider = NATIVE_PROVIDERS.find((p) => p.name === providerName);
if (provider === undefined || repo === undefined || seconds === undefined) {
  throw new Error(
    "usage: holdNativeSandbox.ts <provider name> <repo> <sleep seconds>",
  );
}

const sandbox = await createSandbox({
  branch: "work",
  sandbox: provider.make(),
  cwd: repo,
});
void sandbox.exec(`sleep ${seconds}`);
process.stdout.write("ready\n");
// Keep the event loop alive until the test kills this process.
setInterval(() => undefined, 60_000);
