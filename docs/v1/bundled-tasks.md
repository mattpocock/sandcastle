# Bundled tasks (v1)

> Pre-release: `@ai-hero/sandcastle/v1/tasks` is the v1 API, and it may still change.

Bundled tasks are ready-made jobs you start on a sandbox handle: `implement` turns a ticket into a PR, `review` reviews a PR, `merge` merges one branch into another, and `general` runs a prompt. Each has `start(sandbox, input)`, `outputs` for `verifyFinishReport`, and `limits`, the time it assumes it has.

The sandbox needs `node` (for the session supervisor), `git`, the agent's CLI, and the GitHub CLI `gh`: `implement`, `review`, `implementSpec`, and `merge` from a pull request read or open pull requests with it. Not every image has `gh` (Daytona's default doesn't), so those tasks reject before they clone anything when it's missing. Bake it into your image or snapshot. `githubToken` reaches every git command that talks to the remote, so a private repo works the same as a public one.

## implementSpec

`implementSpec` builds a whole spec: a tracker issue whose tickets are the work, with blocking edges between them. It's written only against the public API, composing the other bundled tasks on one sandbox:

1. `start` clones the repo, creates and pushes the integration branch `sandcastle/implement-spec-<spec>-<random>` from the default branch, runs the chooser and spawns the first round: one `implement` session per ready ticket, named `implement-<ticket>`, each on its own branch from the integration branch, opening its PR against it.
2. Each later round is a `next`. A ticket whose PR opened gets a `merge` session, `merge-<ticket>`, into the integration branch, one merge per round. Then the chooser picks the next tickets. A ticket that ends `blocked`, or whose merge fails, is stuck, and the tickets it blocks are skipped. A session the round's deadline stopped is retried once, as `<step>-<ticket>-retry`.
3. When the chooser has nothing left and a ticket merged, `next` opens the integration branch's PR against the default branch. Its body lists the merged, stuck and skipped tickets, with a `Closes #<n>` line for each merged ticket, and the spec's own `Closes` line only when every ticket merged. It's never merged: a human merges it.
4. One `review` session, named `review`, reviews that PR. After `changes-requested`, one `implement` round 2, named `implement-review-fixes`, addresses its comments on the integration branch. There's no second review.
5. `next` returns `done` with the result: `status` is `complete` (every ticket merged), `partial` (some stuck or skipped) or `blocked` (the chooser said so, or nothing merged, in which case no PR is opened). It also has the `branch`, the `pr`, the `merged`, `stuck` and `skipped` tickets, the `review` verdict with whether it was `fixed`, and a `summary`.

Every session is an ordinary bundled-task session, so `follow()`, `send()`, `status()` and the records show a spec's progress ticket by ticket.

### Driving it detached

An orchestrator that can't stay connected for a whole spec (a serverless function, an Inngest function, a queue worker) runs one round per step. It starts or continues the spec, stores `state`, and detaches. When the round's finish report arrives, it verifies it with `implementSpec.outputs(state)`, reattaches to the same sandbox, and calls `next`. Between rounds no supervisor runs in the sandbox: the reattached handle starts a new one, and the clone and install from `start` are still there.

```ts
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
```

- **`state`** is plain JSON with no token or key in it: store it as it is and pass it back. Pass the same input to every step, with fresh secrets.
- **Env is passed again** on every reattach: Sandcastle never stores the env a sandbox was created with, and the sessions a restarted supervisor runs get only what the reattach passed.
- **Dedupe on `report.data.detachId`**: a finish report can be delivered more than once. A spec that's `done` rejects any further `next`.
- **Close the sandbox on `done`.** Nothing runs in it between rounds, but it stays up until its time limit unless you close it.

### Held

A long-lived process can skip the loop: `run` awaits every round in turn on the handle, with no detach, and resolves with the same result.

```ts
import { createSandbox } from "@ai-hero/sandcastle/v1";
import { daytona } from "@ai-hero/sandcastle/v1/sandboxes/daytona";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";

await using sandbox = await createSandbox({
  provider: daytona(),
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  timeLimitMinutes: implementSpec.limits.timeLimitMinutes,
});

const result = await implementSpec.run(sandbox, {
  repo: "acme/widgets",
  spec: "671",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  skillsContext: { tracker: { kind: "github" } },
  setup: ["npm ci"],
});

console.log(result.status, result.pr?.url, result.summary);
```

### Limits

`implementSpec.limits` is `{ timeLimitMinutes: 480, deadlineMinutes: 90 }`: the sandbox's whole life across rounds, and one round's deadline. Pass `timeLimitMinutes` to `createSandbox`. `start` and every `next` reject, before spawning anything, when the sandbox's kill time leaves less than a round. A provider whose own cap is shorter than the time limit (E2B's Hobby plan stops sandboxes at one hour) fails at `createSandbox`, so use one that allows the whole spec, such as Daytona.

### Options

- `chooser`: which tickets to build next. Default `sessionChooser()`, a short session on Haiku that reads the spec and its tickets through the tracker. Pass `jevChooser()` or your own function of the `Chooser` type to make it deterministic.
- `maxConcurrent`: the most `implement` sessions one round runs at once. Default 3.
- `agent`: the agent every session runs. By default each task's own: Opus for `implement`, Sonnet for `merge` and `review`, Haiku for the chooser.
- `setup`: commands run in each new clone, before its session.
- `record`: where every session's record goes when it ends.
