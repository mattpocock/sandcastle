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

The integration PR's body gives each merged ticket's `implement` summary: what the ticket built. How its merge went is kept beside it in `state.tickets[<ticket>].merge`.

### When a session can't start

A ticket is stuck only for what went wrong with that ticket: its `implement` session ended `blocked` or failed, its merge failed, it reported a branch that isn't on the remote, or the chooser named it with a reference that can't name a session. A start that fails for any other reason (a clone or fetch that fails, a setup command that exits non-zero, a missing `gh`, a sandbox that's gone) would fail the same way for every ticket, so `start` or `next` rejects with that error instead, and no ticket is spent. Fix the cause and call `next` again with the same `state` and report, or `start` again. A start that fails removes the clone it made, so the retry can clone there again.

In a round of several tickets, the ones that started run. A ticket whose start failed is left as it was, and the chooser picks it again in a later round. Only when no ticket of the round starts does the step reject.

### What's left on the remote

Nothing `implementSpec` pushes is deleted:

- **Ticket branches** (`sandcastle/implement-<ticket>-<random>`) stay on the remote after their merge into the integration branch lands, like any merged PR's branch. Delete them yourself once the integration PR merges.
- **The integration branch** stays, as the integration PR's head, until a human merges that PR. When the spec ends with no PR (`blocked`, or no merged ticket changed anything), it's left with nothing to merge: the result's `branch` names it, so delete it then.
- A `start` that rejects after pushing the integration branch leaves that branch too. A second `start` makes a new one.

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

### When the sandbox can't reach the orchestrator

The finish report is POSTed from inside the sandbox, so its URL has to be one the sandbox can reach. An orchestrator on a laptop or a private network can't take that POST. Detach without a finish report instead, and poll for the report on a timer: every detach writes its report to a file in the sandbox whether or not it's sent anywhere, and `status().detaches[].finishReport` reads it once it's there.

```ts
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
```

- **A polled report is unsigned.** There's no webhook signature to check, so `verifyFinishReport` doesn't apply: the report is whatever the sandbox's files say. `next` still checks each session's output against its task's schema, but anything that can write in the sandbox, its agents included, could have written the report. Use this only where you trust the sandbox as much as the work it does, and prefer a signed finish report wherever the sandbox can reach you.
- **Find the report by `detachId`.** `detaches` keeps every detach from the sandbox, so look for the one you stored, not the last one. Storing the new `detachId` after each `next` keeps a report from being used twice.
- **A look doesn't start anything.** `status()` on a reattached handle never starts a session supervisor, so polling a running round leaves it alone.

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
