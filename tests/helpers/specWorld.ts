import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DetachableSandbox, FinishReport } from "@ai-hero/sandcastle/v1";
import { reattachSandbox, verifyFinishReport } from "@ai-hero/sandcastle/v1";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type {
  Choice,
  Chooser,
  ImplementSpecInput,
  ImplementSpecResult,
  ImplementSpecState,
  ImplementSpecStep,
} from "@ai-hero/sandcastle/v1/tasks";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./finishReportReceiver.js";
import { finishReportReceiver, hostPath } from "./finishReportReceiver.js";

// What the implementSpec tests stand on, beside taskWorld's bare repo: a stub
// `claude` that answers each session by name (the basename of the clone it
// runs in), and a function chooser over a fixed graph of blocking edges.
// POSIX only.

/** Runs git in `cwd` on the host; resolves with its trimmed stdout. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** The script a session named `name` runs; it prints the agent's result line. */
export type AgentScript = string;

/** Prints a Claude Code `result` line whose text ends with `<tag>json</tag>`. */
const EMIT = String.raw`const [tag, json] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "Done.\n<" + tag + ">" + json + "</" + tag + ">" }) + "\n");`;

/**
 * A stub `gh`, beside the stub `claude`: `pr create` points
 * `refs/pull/<n>/head` at its `--head` branch on the clone's origin (numbered
 * from 100) and prints the PR's URL; `pr view <n>` prints the PR as the
 * `review` task reads it. Every call is appended to `gh-calls.jsonl` beside
 * `bin`. Anything else fails.
 */
const GH = String.raw`const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(__dirname);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "gh-calls.jsonl"), JSON.stringify({ args, token: process.env.GH_TOKEN ?? "" }) + "\n");
const flag = (name) => args[args.indexOf(name) + 1];
const prs = path.join(dir, "prs");
fs.mkdirSync(prs, { recursive: true });
if (args[0] === "pr" && args[1] === "create") {
  const number = 100 + fs.readdirSync(prs).length;
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", origin, "update-ref", "refs/pull/" + number + "/head", "refs/heads/" + flag("--head")]);
  fs.writeFileSync(path.join(prs, number + ".json"), JSON.stringify({ baseRefName: flag("--base"), headRefName: flag("--head"), closingIssuesReferences: [] }));
  process.stdout.write("https://github.com/o/widgets/pull/" + number + "\n");
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(fs.readFileSync(path.join(prs, args[2] + ".json"), "utf8"));
} else {
  process.exit(1);
}`;

/** One call the stub `gh` saw. */
export interface GhCall {
  readonly args: readonly string[];
  readonly token: string;
}

const isGhCall = (value: unknown): value is GhCall =>
  typeof value === "object" &&
  value !== null &&
  "args" in value &&
  Array.isArray(value.args) &&
  "token" in value &&
  typeof value.token === "string";

/**
 * A stub `claude` in `dir/bin`. Each run appends its session's name to
 * `dir/sessions.log`, prints an init line, waits while `dir/hold` exists,
 * then runs `dir/agents/<name>.sh` in the clone, which prints the result.
 * A name with no script exits 1.
 */
export const stubAgents = async (dir: string) => {
  const bin = path.join(dir, "bin");
  const agents = path.join(dir, "agents");
  await mkdir(bin, { recursive: true });
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(dir, "emit.mjs"), `${EMIT}\n`);
  const script = [
    "#!/bin/sh",
    'name=$(basename "$PWD")',
    `printf '%s\\n' "$name" >> "${dir}/sessions.log"`,
    "IFS= read -r message",
    `printf '%s\\n' "$message" > "${dir}/prompt-$name.json"`,
    `env > "${dir}/env-$name.txt"`,
    `printf '{"type":"system","subtype":"init","session_id":"s-%s"}\\n' "$name"`,
    `while [ -f "${dir}/hold" ]; do sleep 0.05; done`,
    `[ -f "${agents}/$name.sh" ] || exit 1`,
    `EMIT="${dir}/emit.mjs" sh "${agents}/$name.sh" 2>> "${dir}/agents.log" < /dev/null`,
  ].join("\n");
  await writeFile(path.join(bin, "claude"), `${script}\n`);
  await chmod(path.join(bin, "claude"), 0o755);
  await writeFile(path.join(bin, "gh"), `#!/usr/bin/env node\n${GH}\n`);
  await chmod(path.join(bin, "gh"), 0o755);
  return {
    env: { PATH: `${bin}:${hostPath()}` },
    /** Gives the session named `name` its script. */
    script: async (name: string, body: AgentScript) =>
      writeFile(path.join(agents, `${name}.sh`), `${body}\n`),
    /** The sessions run so far, in the order they started. */
    sessions: async () => {
      const log = await readFile(path.join(dir, "sessions.log"), "utf8").catch(
        () => "",
      );
      return log.split("\n").filter((line) => line !== "");
    },
    /** Every agent's env, for checking what reached it. */
    envOf: async (name: string) =>
      readFile(path.join(dir, `env-${name}.txt`), "utf8"),
    /** Every `gh` call so far: its argv, and the token in its env. */
    ghCalls: async (): Promise<GhCall[]> => {
      const log = await readFile(
        path.join(dir, "gh-calls.jsonl"),
        "utf8",
      ).catch(() => "");
      return log
        .split("\n")
        .filter((line) => line !== "")
        .map((line): GhCall => {
          const parsed: unknown = JSON.parse(line);
          if (!isGhCall(parsed)) {
            throw new Error(`not a gh call: ${line}`);
          }
          return parsed;
        });
    },
    /** Holds every agent after its init line until `release()`. */
    hold: async () => writeFile(path.join(dir, "hold"), ""),
    release: async () => rm(path.join(dir, "hold"), { force: true }),
  };
};

/** What `stubAgents` resolves with. */
export type StubAgents = Awaited<ReturnType<typeof stubAgents>>;

const quiet = (command: string): string => `${command} > /dev/null`;

/** An implement agent that commits `<ticket>.md`, pushes its branch and reports `pr-opened`. */
export const opensPr = (ticket: string, pr: number): AgentScript =>
  [
    "set -e",
    `printf '%s\\n' ${ticket} > ${ticket}.md`,
    quiet("git add ."),
    quiet(`git commit --quiet -m 'Add ${ticket}'`),
    "branch=$(git branch --show-current)",
    quiet('git push --quiet origin "HEAD:refs/heads/$branch"'),
    `node "$EMIT" implementResult "$(printf '{"status":"pr-opened","branch":"%s","pr":{"number":${pr},"url":"https://github.com/o/widgets/pull/${pr}"},"summary":"Added ${ticket}."}' "$branch")"`,
  ].join("\n");

/** An implement agent that reports `status` without changing anything. */
export const reportsOnly = (
  status: "blocked" | "no-changes",
  summary: string,
): AgentScript =>
  `node "$EMIT" implementResult "$(printf '{"status":"${status}","branch":"%s","summary":"${summary}"}' "$(git branch --show-current)")"`;

/** A merge agent that pushes the merge Sandcastle committed, and reports `merged`. */
export const pushesMerge = (): AgentScript =>
  [
    "set -e",
    "into=$(git branch --show-current)",
    quiet('git push --quiet origin "$into"'),
    `node "$EMIT" mergeResult "$(printf '{"status":"merged","into":"%s","commit":"%s","summary":"Merged."}' "$into" "$(git rev-parse HEAD)")"`,
  ].join("\n");

/**
 * The `review` session runs under the task's own name, so it clones into the
 * repo-named directory: its stub agent is scripted under this name.
 */
export const REVIEW_AGENT = "widgets";

/** A review agent that reports `approve`. */
export const approves = (): AgentScript =>
  `node "$EMIT" reviewResult '{"verdict":"approve","comments":[],"summary":"Looks good."}'`;

/** One shell word holding `value` as JSON. */
const quotedJson = (value: unknown): string =>
  `'${JSON.stringify(value).replaceAll("'", String.raw`'\''`)}'`;

/** A review agent that reports `changes-requested` with `comments`. */
export const requestsChanges = (comments: readonly string[]): AgentScript =>
  `node "$EMIT" reviewResult ${quotedJson({ verdict: "changes-requested", comments, summary: "Needs fixes." })}`;

/** An implement agent for round 2: commits `FIXES.md` to its branch, pushes, and reports `pr-updated` on `pr`. */
export const fixesReview = (pr: number): AgentScript =>
  [
    "set -e",
    String.raw`printf 'fixed\n' > FIXES.md`,
    quiet("git add ."),
    quiet("git commit --quiet -m 'Address the review'"),
    "branch=$(git branch --show-current)",
    quiet('git push --quiet origin "HEAD:refs/heads/$branch"'),
    `node "$EMIT" implementResult "$(printf '{"status":"pr-updated","branch":"%s","pr":{"number":${pr},"url":"https://github.com/o/widgets/pull/${pr}"},"summary":"Addressed the review."}' "$branch")"`,
  ].join("\n");

/**
 * A chooser over `blockedBy` (each ticket's blockers), with every call's
 * context recorded in `calls`: `next` is every ticket not yet merged, stuck
 * or skipped whose blockers are all merged, and `remaining` the rest.
 */
export const graphChooser = (
  blockedBy: Readonly<Record<string, readonly string[]>>,
  calls: {
    round: number;
    merged: readonly string[];
    stuck: readonly string[];
  }[] = [],
): Chooser => {
  const chooser: Chooser = async (context) => {
    calls.push({
      round: context.round,
      merged: context.merged,
      stuck: context.stuck,
    });
    const over = new Set([
      ...context.merged,
      ...context.stuck,
      ...context.skipped,
    ]);
    const open = Object.keys(blockedBy).filter((ticket) => !over.has(ticket));
    const ready = (ticket: string) =>
      (blockedBy[ticket] ?? []).every((blocker) =>
        context.merged.includes(blocker),
      );
    const choice: Choice = {
      status: "ok",
      next: open.filter((ticket) => ready(ticket)),
      remaining: open.filter((ticket) => !ready(ticket)),
    };
    return choice;
  };
  return chooser;
};

const isState = (value: unknown): value is ImplementSpecState =>
  typeof value === "object" &&
  value !== null &&
  "branch" in value &&
  "sessions" in value;

/** A stored state read back, as an orchestrator reads it between steps. */
export const restored = (stored: string | undefined): ImplementSpecState => {
  const parsed: unknown = JSON.parse(stored ?? "null");
  if (!isState(parsed)) {
    throw new Error("not a state");
  }
  return parsed;
};

const SECRET = "whsec_aW1wbGVtZW50LXNwZWMtcm91bmQtYnktcm91bmQ=";

/** Where a detached drive is, and what it has seen so far. */
interface Drive {
  readonly agents: StubAgents;
  readonly sandbox: DetachableSandbox;
  readonly step: ImplementSpecStep;
  readonly input: ImplementSpecInput;
  /** The fake provider's root, to reattach from a fresh provider. */
  readonly rootDir: string;
  /** Every receiver made, for the test to close. */
  readonly receivers: FinishReportReceiver[];
  /** Each round's detach deadline, by round; agents of a round with one are never released. */
  readonly deadlines: readonly (number | undefined)[];
  readonly rounds?: readonly (readonly string[])[];
  readonly stored?: readonly string[];
  readonly reports?: readonly FinishReport[];
  readonly sandboxIds?: readonly string[];
}

/** What a detached drive saw. */
interface Driven {
  /** Each round's session names. */
  readonly rounds: readonly (readonly string[])[];
  /** The state after every step, as stored. */
  readonly stored: readonly string[];
  /** Each round's verified finish report. */
  readonly reports: readonly FinishReport[];
  /** The sandbox id of every handle the drive used, the first and each reattached one. */
  readonly sandboxIds: readonly string[];
  readonly result: ImplementSpecResult;
}

/** Detaches from the round, verifies its report and reattaches; resolves with the next step. */
const detachRound = async (
  drive: Drive,
  step: ImplementSpecStep & { done: false },
) => {
  const round = drive.rounds?.length ?? 0;
  const hook = await finishReportReceiver();
  drive.receivers.push(hook);
  const deadlineMinutes = drive.deadlines[round];
  await drive.sandbox.detach({
    finishReport: { url: hook.url, secret: SECRET },
    ...(deadlineMinutes === undefined ? {} : { deadlineMinutes }),
  });
  if (deadlineMinutes === undefined) {
    await drive.agents.release();
  }
  const stored = JSON.stringify(step.state);
  const state = restored(stored);
  const delivery = await hook.first();
  const report = await verifyFinishReport({
    body: delivery.body,
    headers: delivery.headers,
    secret: SECRET,
    outputs: implementSpec.outputs(state),
  });
  await drive.agents.hold();
  const sandbox = await reattachSandbox({
    provider: fakeSandbox({ rootDir: drive.rootDir }),
    sandboxId: drive.sandbox.sandboxId,
    env: drive.agents.env,
  });
  if (sandbox === undefined) {
    throw new Error("the sandbox should still be there");
  }
  const next = await implementSpec.next(sandbox, {
    input: drive.input,
    state,
    report,
  });
  return { sandbox, next, stored, report };
};

/**
 * Drives `step` to the end round by round, as a remote orchestrator would:
 * detach with a finish report, store the state as JSON, verify the report
 * with `outputs(state)`, reattach from a fresh provider (env passed again)
 * and call `next`. Rounds start held, so nothing ends before its detach.
 */
export const driveDetached = async (drive: Drive): Promise<Driven> => {
  const { step } = drive;
  const rounds = drive.rounds ?? [];
  const stored = drive.stored ?? [];
  const reports = drive.reports ?? [];
  const sandboxIds = [...(drive.sandboxIds ?? []), drive.sandbox.sandboxId];
  if (step.done) {
    await drive.sandbox.close();
    return {
      rounds,
      stored: [...stored, JSON.stringify(step.state)],
      reports,
      sandboxIds,
      result: step.result,
    };
  }
  const done = await detachRound(drive, step);
  return driveDetached({
    ...drive,
    sandbox: done.sandbox,
    step: done.next,
    rounds: [...rounds, Object.keys(step.sessions)],
    stored: [...stored, done.stored],
    reports: [...reports, done.report],
    sandboxIds,
  });
};
