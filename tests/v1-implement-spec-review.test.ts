import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type {
  ImplementSpecInput,
  ImplementSpecResult,
} from "@ai-hero/sandcastle/v1/tasks";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import type { GhCall, StubAgents } from "./helpers/specWorld.js";
import {
  approves,
  driveDetached,
  fixesReview,
  git,
  graphChooser,
  opensPr,
  pushesMerge,
  reportsOnly,
  requestsChanges,
  restored,
  REVIEW_AGENT,
  stubAgents,
} from "./helpers/specWorld.js";
import { bareRepo } from "./helpers/taskWorld.js";

// The end of implementSpec, through `/v1/tasks` on the fake sandbox: once no
// ticket is left, the integration PR (by `gh`, stubbed), one `review` on it,
// at most one `implement-review-fixes` round, and the result. The spec has
// three tickets: B is blocked by A, and C is independent. POSIX only.

const TOKEN = "ghs_implementspecreviewtoken0123456";

const GITHUB = { tracker: { kind: "github" } } as const;

const SPEC = { A: [], B: ["A"], C: [] } as const;

const COMMENTS = ["Rename the heading in A.md.", "Say why C exists."];

/** The one `gh pr create` call's flag `name`. */
const flagOf = (call: GhCall | undefined, name: string): string => {
  const args = call?.args ?? [];
  return args[args.indexOf(name) + 1] ?? "";
};

const prCreates = (calls: readonly GhCall[]): GhCall[] =>
  calls.filter((call) => call.args[0] === "pr" && call.args[1] === "create");

describe.skipIf(process.platform === "win32")(
  "implementSpec's integration PR, review and fix round (v1)",
  { timeout: 60_000 },
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";
    let receivers: FinishReportReceiver[] = [];

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-spec-pr-"));
      provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
      origin = await bareRepo(rootDir);
    });

    afterEach(async () => {
      await provider.closeAll();
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
      await rm(rootDir, { recursive: true, force: true });
    });

    const world = async (agentDir = "agent") => {
      const agents = await stubAgents(path.join(rootDir, agentDir));
      const sandbox = await createSandbox({
        provider,
        env: agents.env,
        timeLimitMinutes: implementSpec.limits.timeLimitMinutes,
      });
      return { agents, sandbox };
    };

    const input = (
      extra: Partial<ImplementSpecInput> = {},
    ): ImplementSpecInput => ({
      repo: origin,
      spec: "7",
      githubToken: TOKEN,
      skillsContext: GITHUB,
      chooser: graphChooser(SPEC),
      ...extra,
    });

    /** Scripts every ticket of the spec to open a PR and merge it. */
    const scriptTickets = async (agents: StubAgents) => {
      await agents.script("implement-A", opensPr("A", 1));
      await agents.script("implement-B", opensPr("B", 2));
      await agents.script("implement-C", opensPr("C", 3));
      await Promise.all(
        ["merge-A", "merge-B", "merge-C"].map(async (name) =>
          agents.script(name, pushesMerge()),
        ),
      );
    };

    it("opens one integration PR against the default branch once every ticket merged, reviews it once, and ends complete on approve", async () => {
      const { agents, sandbox } = await world();
      await scriptTickets(agents);
      await agents.script(REVIEW_AGENT, approves());
      const mainBefore = git(origin, "rev-parse", "main");

      const result = await implementSpec.run(sandbox, input());

      expect(result).toMatchObject({
        status: "complete",
        pr: { number: 100, url: "https://github.com/o/widgets/pull/100" },
        review: { verdict: "approve", fixed: false },
      });
      const creates = prCreates(await agents.ghCalls());
      expect(creates).toHaveLength(1);
      expect(flagOf(creates[0], "--base")).toBe("main");
      expect(flagOf(creates[0], "--head")).toBe(result.branch);
      expect(creates[0]?.token).toBe(TOKEN);
      const body = flagOf(creates[0], "--body");
      for (const line of ["Closes #A", "Closes #B", "Closes #C", "Closes #7"]) {
        expect(body).toContain(line);
      }
      // Each ticket reads as what its implement session built, not its merge.
      for (const ticket of ["A", "B", "C"]) {
        expect(body).toContain(`- #${ticket}: Added ${ticket}.`);
      }
      expect(body).not.toContain("Merged.");
      const sessions = await agents.sessions();
      expect(sessions.at(-1)).toBe(REVIEW_AGENT);
      expect(sessions).not.toContain("implement-review-fixes");
      // The PR is left open: nothing reached the default branch.
      expect(git(origin, "rev-parse", "main")).toBe(mainBefore);
      const status = await sandbox.status();
      expect(status.ended.map((ended) => ended.name)).toContain("review");
    });

    it("runs exactly one implement-review-fixes round on the integration branch after changes-requested, with the review's comments, and no second review", async () => {
      const { agents, sandbox } = await world();
      await scriptTickets(agents);
      await agents.script(REVIEW_AGENT, requestsChanges(COMMENTS));
      await agents.script("implement-review-fixes", fixesReview(100));

      const result = await implementSpec.run(sandbox, input());

      expect(result).toMatchObject({
        status: "complete",
        pr: { number: 100 },
        review: { verdict: "changes-requested", fixed: true },
      });
      const sessions = await agents.sessions();
      expect(sessions.slice(-2)).toStrictEqual([
        REVIEW_AGENT,
        "implement-review-fixes",
      ]);
      expect(sessions.filter((name) => name === REVIEW_AGENT)).toHaveLength(1);
      const prompt = await readFile(
        path.join(rootDir, "agent", "prompt-implement-review-fixes.json"),
        "utf8",
      );
      for (const comment of COMMENTS) {
        expect(prompt).toContain(comment);
      }
      expect(prompt).toContain(result.branch);
      expect(
        git(origin, "ls-tree", "--name-only", result.branch).split("\n"),
      ).toContain("FIXES.md");
      expect(prCreates(await agents.ghCalls())).toHaveLength(1);
    });

    it("reports the review unfixed when the fix round couldn't change anything", async () => {
      const { agents, sandbox } = await world();
      await scriptTickets(agents);
      await agents.script(REVIEW_AGENT, requestsChanges(COMMENTS));
      await agents.script(
        "implement-review-fixes",
        reportsOnly("blocked", "The comments contradict the spec."),
      );

      const result = await implementSpec.run(sandbox, input());

      expect(result.review).toStrictEqual({
        verdict: "changes-requested",
        fixed: false,
      });
      expect(result.summary).toContain("The comments contradict the spec.");
    });

    it("ends without a verdict, and says why, when the review session fails", async () => {
      const { agents, sandbox } = await world();
      await scriptTickets(agents);

      const result = await implementSpec.run(sandbox, input());

      expect(result).toMatchObject({ status: "complete", pr: { number: 100 } });
      expect(result.review).toBeUndefined();
      expect(result.summary).toContain("The review failed");
      await expect(agents.sessions()).resolves.not.toContain(
        "implement-review-fixes",
      );
    });

    it("ends partial with a stuck ticket, and the PR body leaves out the spec's Closes line", async () => {
      const { agents, sandbox } = await world();
      await agents.script(
        "implement-A",
        reportsOnly("blocked", "The ticket is unclear."),
      );
      await agents.script("implement-C", opensPr("C", 3));
      await agents.script("merge-C", pushesMerge());
      await agents.script(REVIEW_AGENT, approves());

      const result = await implementSpec.run(sandbox, input());

      expect(result).toMatchObject({
        status: "partial",
        merged: ["C"],
        skipped: ["B"],
        pr: { number: 100 },
      });
      const body = flagOf(prCreates(await agents.ghCalls())[0], "--body");
      expect(body).toContain("Closes #C");
      expect(body).not.toContain("Closes #A");
      expect(body).not.toContain("Closes #B");
      expect(body).not.toContain("Closes #7");
      expect(body).toContain("The ticket is unclear.");
      expect(body).toMatch(/Skipped[\s\S]*#B/u);
    });

    it("opens no PR and ends blocked when nothing merged", async () => {
      const { agents, sandbox } = await world();
      await agents.script("implement-A", reportsOnly("blocked", "No."));
      await agents.script("implement-C", reportsOnly("blocked", "No."));

      const result = await implementSpec.run(sandbox, input());

      expect(result.status).toBe("blocked");
      expect(result.pr).toBeUndefined();
      expect(result.review).toBeUndefined();
      await expect(agents.ghCalls()).resolves.toStrictEqual([]);
    });

    it("opens no PR when every ticket needed no changes, so there's nothing to review", async () => {
      const { agents, sandbox } = await world();
      await Promise.all(
        ["A", "B", "C"].map(async (ticket) =>
          agents.script(
            `implement-${ticket}`,
            reportsOnly("no-changes", "Already done."),
          ),
        ),
      );

      const result = await implementSpec.run(sandbox, input());

      expect(result).toMatchObject({ status: "complete" });
      expect(result.pr).toBeUndefined();
      await expect(agents.ghCalls()).resolves.toStrictEqual([]);
    });

    it("runs the spec fully detached, one detach and report per round on one sandbox, with the held run's result", async () => {
      const held = await world("held-agent");
      await scriptTickets(held.agents);
      await held.agents.script(REVIEW_AGENT, requestsChanges(COMMENTS));
      await held.agents.script("implement-review-fixes", fixesReview(100));
      const heldResult = await implementSpec.run(held.sandbox, input());

      const { agents, sandbox } = await world();
      await scriptTickets(agents);
      await agents.script(REVIEW_AGENT, requestsChanges(COMMENTS));
      await agents.script("implement-review-fixes", fixesReview(100));
      await agents.hold();
      const spec = input();
      const step = await implementSpec.start(sandbox, spec);
      const driven = await driveDetached({
        agents,
        sandbox,
        step,
        input: spec,
        deadlines: [],
        rootDir: path.join(rootDir, "sandboxes"),
        receivers,
      });

      expect(driven.rounds).toStrictEqual([
        ["implement-A", "implement-C"],
        ["merge-A"],
        ["merge-C"],
        ["implement-B"],
        ["merge-B"],
        ["review"],
        ["implement-review-fixes"],
      ]);
      expect(driven.reports).toHaveLength(driven.rounds.length);
      expect(
        new Set(driven.reports.map((report) => report.data.detachId)).size,
      ).toBe(driven.rounds.length);
      expect(new Set(driven.sandboxIds)).toStrictEqual(
        new Set([sandbox.sandboxId]),
      );
      const comparable = (result: ImplementSpecResult) => ({
        ...result,
        branch: "",
        pr: undefined,
        summary: "",
      });
      expect(comparable(driven.result)).toStrictEqual(comparable(heldResult));
      expect(driven.result.pr?.number).toBe(100);
      for (const state of driven.stored) {
        expect(state).not.toContain(TOKEN);
      }
      expect(restored(driven.stored.at(-1)).done).toBe(true);
    });
  },
);
