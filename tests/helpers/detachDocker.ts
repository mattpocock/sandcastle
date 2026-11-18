/**
 * A host process that creates a docker() (or podman()) sandbox, starts a session in it,
 * detaches with a finish report, prints `{ sandboxId, detachId }` and exits.
 * Run as a separate Node process (see {@link detachDockerFromChild}), so the
 * detached work outlives the process that started it.
 *
 *   node --import tsx tests/helpers/detachDocker.ts <docker|podman> <image> <report url> <secret>
 */

import { createSandbox, Output } from "@ai-hero/sandcastle/v1";
import { docker } from "@ai-hero/sandcastle/v1/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/v1/sandboxes/podman";
import { fakeAgent } from "@ai-hero/sandcastle/v1/testing";
import { z } from "zod";

const [engine, image, url, secret] = process.argv.slice(2);
if (
  (engine !== "docker" && engine !== "podman") ||
  image === undefined ||
  url === undefined ||
  secret === undefined
) {
  throw new Error(
    "usage: detachDocker.ts <docker|podman> <image> <report url> <secret>",
  );
}

const sandbox = await createSandbox({
  provider: engine === "docker" ? docker({ image }) : podman({ image }),
  env: { SANDBOX_TOKEN: "for-sessions" },
});
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
  // Long enough that it is still running when detach() checks, under load.
  completionTimeoutSeconds: 3,
});
const receipt = await sandbox.detach({ finishReport: { url, secret } });
process.stdout.write(
  `${JSON.stringify({ sandboxId: receipt.sandboxId, detachId: receipt.detachId })}\n`,
);
process.exit(0);
