import type { DetachableSandbox } from "@ai-hero/sandcastle/v1";
import {
  createSandbox,
  reattachSandbox,
  verifyFinishReport,
} from "@ai-hero/sandcastle/v1";
import { daytona } from "@ai-hero/sandcastle/v1/sandboxes/daytona";
import type {
  ImplementSpecInput,
  ImplementSpecResult,
  ImplementSpecState,
  ImplementSpecStep,
} from "@ai-hero/sandcastle/v1/tasks";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";

/** Where the orchestrator keeps each spec's state between rounds: a database row, a KV entry. */
export interface SpecStore {
  readonly save: (
    sandboxId: string,
    state: ImplementSpecState,
  ) => Promise<void>;
  readonly load: (sandboxId: string) => Promise<ImplementSpecState>;
}

const REPORT_URL = "https://orchestrator.example.com/api/finish-report";
const SECRET = process.env.FINISH_REPORT_SECRET ?? "";

// Secrets are never stored, by the sandbox or in `state`: read them again
// for every step, and pass them to every reattach.
const env = () => ({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" });

const input = (spec: string): ImplementSpecInput => ({
  repo: "acme/widgets",
  spec,
  githubToken: process.env.GITHUB_TOKEN ?? "",
  skillsContext: { tracker: { kind: "github" } },
  setup: ["npm ci"],
});

/** Stores the step's state, then detaches for the next round, or closes the sandbox at the end. */
const settle = async (
  store: SpecStore,
  sandbox: DetachableSandbox,
  step: ImplementSpecStep,
): Promise<ImplementSpecResult | undefined> => {
  await store.save(sandbox.sandboxId, step.state);
  if (step.done) {
    await sandbox.close();
    return step.result;
  }
  await sandbox.detach({
    finishReport: {
      url: `${REPORT_URL}?sandbox=${encodeURIComponent(sandbox.sandboxId)}`,
      secret: SECRET,
    },
  });
  return undefined;
};

/** Step 1: create the sandbox, start the spec, detach. */
export const startSpec = async (store: SpecStore, spec: string) => {
  const sandbox = await createSandbox({
    provider: daytona(),
    env: env(),
    timeLimitMinutes: implementSpec.limits.timeLimitMinutes,
  });
  return settle(
    store,
    sandbox,
    await implementSpec.start(sandbox, input(spec)),
  );
};

/** Every later step: a round's finish report arrives; verify it, reattach, run `next`, detach. */
export const onFinishReport = async (store: SpecStore, request: Request) => {
  const sandboxId = new URL(request.url).searchParams.get("sandbox") ?? "";
  const state = await store.load(sandboxId);
  const report = await verifyFinishReport({
    body: await request.text(),
    headers: request.headers,
    secret: SECRET,
    outputs: implementSpec.outputs(state),
  });
  const sandbox = await reattachSandbox({
    provider: daytona(),
    sandboxId,
    env: env(),
  });
  if (sandbox === undefined) {
    throw new Error(`Sandbox ${sandboxId} has no session supervisor`);
  }
  const step = await implementSpec.next(sandbox, {
    input: input(state.spec),
    state,
    report,
  });
  return settle(store, sandbox, step);
};
