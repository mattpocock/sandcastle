import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetachableSandbox } from "@ai-hero/sandcastle/v1";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type {
  ImplementSpecInput,
  ImplementSpecStep,
} from "@ai-hero/sandcastle/v1/tasks";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import type { StubAgents } from "./helpers/specWorld.js";
import {
  driveDetached,
  git,
  graphChooser,
  opensPr,
  pushesMerge,
  reportsOnly,
  restored,
  stubAgents,
} from "./helpers/specWorld.js";
import { bareRepo } from "./helpers/taskWorld.js";

// implementSpec through `/v1/tasks`, on the fake sandbox: a local bare repo
// stands in for GitHub, a stub `claude` answers each session by name, and a
// function chooser reads a fixed graph of blocking edges. The spec has three
// tickets: B is blocked by A, and C is independent. POSIX only, like the
// other task tests.

const TOKEN = "ghs_implementspectesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const SPEC = { A: [], B: ["A"], C: [] } as const;

describe.skipIf(process.platform === "win32")(
  "implementSpec, held and round by round (v1)",
  { timeout: 60_000 },
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";
    let receivers: FinishReportReceiver[] = [];

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-spec-"));
      provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
      origin = await bareRepo(rootDir);
    });

    afterEach(async () => {
      await provider.closeAll();
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
      await rm(rootDir, { recursive: true, force: true });
    });

    /** A sandbox whose agents answer by session name. */
    const world = async (
      timeLimitMinutes: number = implementSpec.limits.timeLimitMinutes,
    ) => {
      const agents = await stubAgents(path.join(rootDir, "agent"));
      const sandbox = await createSandbox({
        provider,
        env: agents.env,
        timeLimitMinutes,
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

    /** Drives `step` to the end round by round, detached, reattaching between rounds. */
    const detached = async (from: {
      readonly agents: StubAgents;
      readonly sandbox: DetachableSandbox;
      readonly step: ImplementSpecStep;
      readonly input: ImplementSpecInput;
      readonly deadlines?: readonly (number | undefined)[];
    }) =>
      driveDetached({
        deadlines: [],
        ...from,
        rootDir: path.join(rootDir, "sandboxes"),
        receivers,
      });

    /** Scripts every session of the A, C, B spec to open a PR and merge it. */
    const scriptAll = async (agents: StubAgents) => {
      await agents.script("implement-A", opensPr("A", 1));
      await agents.script("implement-B", opensPr("B", 2));
      await agents.script("implement-C", opensPr("C", 3));
      await Promise.all(
        ["merge-A", "merge-B", "merge-C"].map(async (name) =>
          agents.script(name, pushesMerge()),
        ),
      );
    };

    it("builds {A, C}, merges them, then builds and merges B, all into the integration branch", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      const mainBefore = git(origin, "rev-parse", "main");

      const result = await implementSpec.run(sandbox, input());

      expect(result.status).toBe("complete");
      expect(new Set(result.merged)).toStrictEqual(new Set(["A", "B", "C"]));
      expect(result.stuck).toStrictEqual([]);
      expect(result.skipped).toStrictEqual([]);
      expect(result.branch).toMatch(
        /^sandcastle\/implement-spec-7-[0-9a-f]{8}$/u,
      );
      const files = git(origin, "ls-tree", "--name-only", result.branch);
      expect(new Set(files.split("\n"))).toStrictEqual(
        new Set(["A.md", "B.md", "C.md", "README.md"]),
      );
      // B was built on top of A.
      const bBranch = git(
        origin,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/sandcastle/implement-b-*",
      );
      expect(git(origin, "ls-tree", "--name-only", bBranch)).toContain("A.md");
      expect(git(origin, "rev-parse", "main")).toBe(mainBefore);
      const order = await agents.sessions();
      expect(order.slice(2)).toStrictEqual([
        "merge-A",
        "merge-C",
        "implement-B",
        "merge-B",
      ]);
      expect(new Set(order.slice(0, 2))).toStrictEqual(
        new Set(["implement-A", "implement-C"]),
      );
    });

    it("runs round by round across detaches: implement-A and implement-C, merge-A, merge-C, implement-B, merge-B", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      await agents.hold();
      const spec = input();

      const step = await implementSpec.start(sandbox, spec);
      const { rounds, stored, reports, result } = await detached({
        agents,
        sandbox,
        step,
        input: spec,
      });

      expect(rounds).toStrictEqual([
        ["implement-A", "implement-C"],
        ["merge-A"],
        ["merge-C"],
        ["implement-B"],
        ["merge-B"],
      ]);
      expect(reports.map((report) => report.data.status)).toStrictEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
      expect(result.status).toBe("complete");
      expect(
        git(origin, "ls-tree", "--name-only", result.branch).split("\n"),
      ).toHaveLength(4);
      for (const state of stored) {
        expect(state).not.toContain(TOKEN);
      }
      expect(restored(stored.at(-1)).tickets).toMatchObject({
        A: { status: "merged", pr: { number: 1 } },
        B: { status: "merged" },
        C: { status: "merged" },
      });
      await expect(agents.envOf("implement-B")).resolves.toContain(
        `GH_TOKEN=${TOKEN}`,
      );
    });

    it("retries a ticket round the deadline cut short once, under new session names", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      await agents.script("implement-A-retry", opensPr("A", 1));
      await agents.script("implement-C-retry", opensPr("C", 3));
      await agents.hold();
      const spec = input();

      const step = await implementSpec.start(sandbox, spec);
      const { rounds, reports, result } = await detached({
        agents,
        sandbox,
        step,
        input: spec,
        deadlines: [0.02],
      });

      expect(reports[0]?.data.status).toBe("failed");
      expect(rounds.slice(0, 2)).toStrictEqual([
        ["implement-A", "implement-C"],
        ["implement-A-retry", "implement-C-retry"],
      ]);
      expect(rounds.slice(2)).toStrictEqual([
        ["merge-A"],
        ["merge-C"],
        ["implement-B"],
        ["merge-B"],
      ]);
      expect(result.status).toBe("complete");
    });

    it("leaves a blocked ticket stuck and skips what it blocks, while the independent ticket still merges", async () => {
      const { agents, sandbox } = await world();
      await agents.script(
        "implement-A",
        reportsOnly("blocked", "The ticket is unclear."),
      );
      await agents.script("implement-C", opensPr("C", 3));
      await agents.script("merge-C", pushesMerge());

      const result = await implementSpec.run(sandbox, input());

      expect(result.status).toBe("partial");
      expect(result.merged).toStrictEqual(["C"]);
      expect(result.stuck).toStrictEqual([
        { ticket: "A", reason: "The ticket is unclear." },
      ]);
      expect(result.skipped).toStrictEqual(["B"]);
      expect(
        git(origin, "ls-tree", "--name-only", result.branch),
      ).not.toContain("A.md");
      await expect(agents.sessions()).resolves.not.toContain("implement-B");
    });

    it("counts no-changes as done, and leaves a ticket whose merge fails stuck, skipping what it blocks", async () => {
      const { agents, sandbox } = await world();
      await agents.script("implement-A", opensPr("A", 1));
      await agents.script(
        "implement-C",
        reportsOnly("no-changes", "Already done."),
      );
      await agents.script(
        "merge-A",
        `node "$EMIT" mergeResult '{"status":"conflict-unresolved","into":"x","summary":"Both sides rewrote README."}'`,
      );

      const result = await implementSpec.run(sandbox, input());

      expect(result).toMatchObject({
        status: "partial",
        merged: ["C"],
        stuck: [
          {
            ticket: "A",
            reason:
              "the merge ended conflict-unresolved: Both sides rewrote README.",
          },
        ],
        skipped: ["B"],
      });
      await expect(agents.sessions()).resolves.not.toContain("merge-C");
    });

    it("runs the default chooser, sessionChooser, as a session named choose-1", async () => {
      const { agents, sandbox } = await world();
      await agents.script(
        "work",
        `node "$EMIT" choice '{"status":"blocked","next":[],"remaining":[],"reason":"no tickets"}'`,
      );
      const { chooser: _unused, ...spec } = input();

      const result = await implementSpec.run(sandbox, spec);
      const status = await sandbox.status();

      expect(result.status).toBe("blocked");
      expect(result.summary).toContain("no tickets");
      expect(status.ended.map((ended) => ended.name)).toStrictEqual([
        "choose-1",
      ]);
    });

    it("ends done and blocked straight away when the chooser says blocked, having pushed the integration branch", async () => {
      const { agents, sandbox } = await world();

      const step = await implementSpec.start(
        sandbox,
        input({
          chooser: async () => ({
            status: "blocked",
            next: [],
            remaining: [],
            reason: "spec 7 has no tickets",
          }),
        }),
      );

      expect(step).toMatchObject({
        done: true,
        result: { status: "blocked" },
      });
      expect(JSON.stringify(step)).toContain("spec 7 has no tickets");
      expect(git(origin, "rev-parse", step.state.branch)).toBe(
        git(origin, "rev-parse", "main"),
      );
      await expect(agents.sessions()).resolves.toStrictEqual([]);
    });

    it("rejects before cloning or choosing when the kill time leaves less than a round", async () => {
      const { sandbox } = await world(60);
      const calls: Parameters<typeof graphChooser>[1] = [];

      await expect(
        implementSpec.start(
          sandbox,
          input({ chooser: graphChooser(SPEC, calls) }),
        ),
      ).rejects.toThrow(
        /implementSpec: the sandbox leaves .* but a round needs 90/u,
      );
      expect(calls).toStrictEqual([]);
      await expect(
        readdir(path.join(provider.pathOf(sandbox.sandboxId), "work")),
      ).resolves.toStrictEqual([]);
    });
  },
);
