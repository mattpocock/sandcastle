/**
 * A host process that creates a bwrap() sandbox, starts a session in it,
 * detaches with a finish report, prints the receipt as one JSON line and
 * exits. Run as a separate Node process (see {@link detachFromNewProcess}),
 * so a test can show the detached run reports after the process that made
 * the sandbox has gone.
 *
 *   node --import tsx tests/helpers/detachBwrapSandbox.ts <report url> <secret>
 */

import { createSandbox, Output } from "@ai-hero/sandcastle/v1";
import { bwrap } from "@ai-hero/sandcastle/v1/sandboxes/bwrap";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import { z } from "zod";

const [url, secret] = process.argv.slice(2);
if (url === undefined || secret === undefined) {
  throw new Error("usage: detachBwrapSandbox.ts <report url> <secret>");
}

const sandbox = await createSandbox({ provider: bwrap() });
await sandbox.spawnSession({
  name: "implement",
  // Prints its answer, then hangs until the completion timeout ends it.
  agent: fakeAgent({
    lines: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: '<answer>{"answer": 42}</answer>',
      }),
    ],
    hang: true,
  }),
  prompt: "Reply in <answer> tags.",
  output: Output.object({
    tag: "answer",
    schema: z.object({ answer: z.number() }),
  }),
  completionTimeoutSeconds: 2,
});
const receipt = await sandbox.detach({ finishReport: { url, secret } });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
