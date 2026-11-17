import type { DetachableSandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox, reattachSandbox } from "@ai-hero/sandcastle/v1";
import { daytona } from "@ai-hero/sandcastle/v1/sandboxes/daytona";
import type {
  ImplementSpecInput,
  ImplementSpecResult,
  ImplementSpecState,
  ImplementSpecStep,
} from "@ai-hero/sandcastle/v1/tasks";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";

/** A spec between polls: its state, and the detach whose report it waits for. */
export interface PolledSpec {
  readonly state: ImplementSpecState;
  readonly detachId: string;
}

/** Where the orchestrator keeps each spec between polls: a file, a database row. */
export interface PolledSpecStore {
  readonly save: (sandboxId: string, spec: PolledSpec) => Promise<void>;
  readonly load: (sandboxId: string) => Promise<PolledSpec>;
}

const env = () => ({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" });

const input = (spec: string): ImplementSpecInput => ({
  repo: "acme/widgets",
  spec,
  githubToken: process.env.GITHUB_TOKEN ?? "",
  skillsContext: { tracker: { kind: "github" } },
  setup: ["npm ci"],
});

/** Detaches with no finish report, and stores the detach to poll for; closes the sandbox at the end. */
const settle = async (
  store: PolledSpecStore,
  sandbox: DetachableSandbox,
  step: ImplementSpecStep,
): Promise<ImplementSpecResult | undefined> => {
  if (step.done) {
    await sandbox.close();
    return step.result;
  }
  const receipt = await sandbox.detach();
  await store.save(sandbox.sandboxId, {
    state: step.state,
    detachId: receipt.detachId,
  });
  return undefined;
};

/** Step 1: create the sandbox, start the spec, detach. */
export const startSpec = async (store: PolledSpecStore, spec: string) => {
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

/** On a timer: once the round's report is written, run `next` and detach again. */
export const poll = async (store: PolledSpecStore, sandboxId: string) => {
  const { state, detachId } = await store.load(sandboxId);
  const sandbox = await reattachSandbox({
    provider: daytona(),
    sandboxId,
    env: env(),
  });
  if (sandbox === undefined) {
    throw new Error(`Sandbox ${sandboxId} has no session supervisor`);
  }
  const status = await sandbox.status();
  const report = status.detaches.find(
    (detach) => detach.detachId === detachId,
  )?.finishReport;
  if (report === undefined) {
    return undefined; // The round is still running: poll again later.
  }
  const step = await implementSpec.next(sandbox, {
    input: input(state.spec),
    state,
    report,
  });
  return settle(store, sandbox, step);
};
