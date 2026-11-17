import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "@ai-hero/sandcastle/v1";
import type { FakeSandboxProvider } from "@ai-hero/sandcastle/v1/testing";
import { fakeSandbox } from "@ai-hero/sandcastle/v1/testing";
import type {
  Choice,
  Chooser,
  ImplementSpecInput,
} from "@ai-hero/sandcastle/v1/tasks";
import { implementSpec } from "@ai-hero/sandcastle/v1/tasks";
import type { FinishReportReceiver } from "./helpers/finishReportReceiver.js";
import type { StubAgents } from "./helpers/specWorld.js";
import {
  approves,
  detachAndReattach,
  driveDetached,
  graphChooser,
  opensPr,
  pushesMerge,
  REVIEW_AGENT,
  stubAgents,
} from "./helpers/specWorld.js";
import { bareRepo } from "./helpers/taskWorld.js";

// implementSpec when a session can't start. A failure in the sandbox, the
// repo or the input (a failing setup command here) would hit every ticket, so
// `start` and `next` reject and the caller retries with the same state. What
// an agent got wrong for one ticket (a branch it never pushed, a ticket
// reference that can't name a session) still leaves that ticket stuck.
// POSIX only, like the other task tests.

const TOKEN = "ghs_implementspectesttoken0123456789";

const GITHUB = { tracker: { kind: "github" } } as const;

const SPEC = { A: [], B: ["A"], C: [] } as const;

/** A setup command that fails, as a sandbox problem would, in the clones `pattern` matches while `flag` exists. */
const failsWhile = (flag: string, pattern: string, once = false): string =>
  `case "$PWD" in ${pattern}) if [ -f '${flag}' ]; then ${once ? `rm '${flag}'; ` : ""}echo 'no space left on device' >&2; exit 3; fi ;; esac`;

/** A chooser that answers `first` once, then chooses nothing. */
const choosesOnce = (first: Choice): Chooser => {
  const choices = [first];
  return async () =>
    choices.shift() ?? { status: "ok", next: [], remaining: [] };
};

describe.skipIf(process.platform === "win32")(
  "implementSpec, when a session can't start (v1)",
  { timeout: 60_000 },
  () => {
    let rootDir = "";
    let provider: FakeSandboxProvider = fakeSandbox();
    let origin = "";
    let flag = "";
    let receivers: FinishReportReceiver[] = [];

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), "sandcastle-v1-spec-start-"));
      provider = fakeSandbox({ rootDir: path.join(rootDir, "sandboxes") });
      origin = await bareRepo(rootDir);
      flag = path.join(rootDir, "broken");
    });

    afterEach(async () => {
      await provider.closeAll();
      await Promise.all(receivers.map(async (made) => made.close()));
      receivers = [];
      await rm(rootDir, { recursive: true, force: true });
    });

    const world = async () => {
      const agents = await stubAgents(path.join(rootDir, "agent"));
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

    const scriptAll = async (agents: StubAgents) => {
      await agents.script(REVIEW_AGENT, approves());
      await agents.script("implement-A", opensPr("A", 1));
      await agents.script("implement-B", opensPr("B", 2));
      await agents.script("implement-C", opensPr("C", 3));
      await Promise.all(
        ["merge-A", "merge-B", "merge-C"].map(async (name) =>
          agents.script(name, pushesMerge()),
        ),
      );
    };

    const exists = async (file: string) =>
      stat(file).then(
        () => true,
        () => false,
      );

    it("rejects next when a merge can't start, and the same state and report go on once the sandbox is fixed", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      await agents.hold();
      const spec = input({ setup: [failsWhile(flag, "*/merge-A")] });
      await writeFile(flag, "");
      const sandboxes = path.join(rootDir, "sandboxes");

      const step = await implementSpec.start(sandbox, spec);
      const reattached = await detachAndReattach(
        { agents, sandbox, rootDir: sandboxes, receivers },
        step,
      );
      const retry = {
        input: spec,
        state: reattached.state,
        report: reattached.report,
      };

      await expect(
        implementSpec.next(reattached.sandbox, retry),
      ).rejects.toThrow(/no space left on device/u);
      // The failed start left no clone behind for the retry to trip on.
      await expect(
        exists(
          path.join(provider.pathOf(sandbox.sandboxId), "work", "merge-A"),
        ),
      ).resolves.toBe(false);

      await rm(flag);
      const next = await implementSpec.next(reattached.sandbox, retry);
      expect(next.done).toBe(false);
      expect(next.state.tickets["A"]?.status).toBe("merging");
      const { result } = await driveDetached({
        agents,
        sandbox: reattached.sandbox,
        step: next,
        input: spec,
        deadlines: [],
        rootDir: sandboxes,
        receivers,
      });

      expect(result).toMatchObject({ status: "complete", stuck: [] });
      expect(new Set(result.merged)).toStrictEqual(new Set(["A", "B", "C"]));
    });

    it("rejects start when no ticket of the round can start, and a second start on the same sandbox goes on", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      const spec = input({ setup: [failsWhile(flag, "*/implement-*")] });
      await writeFile(flag, "");

      await expect(implementSpec.start(sandbox, spec)).rejects.toThrow(
        /no space left on device/u,
      );
      await expect(agents.sessions()).resolves.toStrictEqual([]);

      await rm(flag);
      const result = await implementSpec.run(sandbox, spec);

      expect(result).toMatchObject({ status: "complete", stuck: [] });
    });

    it("runs the tickets that started, and the chooser picks a ticket that couldn't start again in a later round", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      await writeFile(flag, "");

      const result = await implementSpec.run(
        sandbox,
        input({ setup: [failsWhile(flag, "*/implement-C", true)] }),
      );

      expect(result).toMatchObject({ status: "complete", stuck: [] });
      expect(new Set(result.merged)).toStrictEqual(new Set(["A", "B", "C"]));
      const sessions = await agents.sessions();
      expect(sessions.slice(0, 2)).toStrictEqual(["implement-A", "merge-A"]);
      expect(sessions.filter((name) => name === "implement-C")).toHaveLength(1);
    });

    it("leaves a ticket stuck when its implement session reported a branch that isn't on the remote", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      await agents.script(
        "implement-A",
        `node "$EMIT" implementResult '{"status":"pr-opened","branch":"sandcastle/nowhere","pr":{"number":1,"url":"https://github.com/o/widgets/pull/1"},"summary":"Added A."}'`,
      );

      const result = await implementSpec.run(sandbox, input());

      expect(result).toMatchObject({
        status: "partial",
        merged: ["C"],
        skipped: ["B"],
      });
      expect(result.stuck).toHaveLength(1);
      expect(result.stuck[0]?.ticket).toBe("A");
      expect(result.stuck[0]?.reason).toContain(
        `"sandcastle/nowhere", which isn't on the remote`,
      );
      await expect(agents.sessions()).resolves.not.toContain("merge-A");
    });

    it("leaves a ticket stuck when the chooser names it with a reference that can't name a session", async () => {
      const { agents, sandbox } = await world();
      await scriptAll(agents);
      const chooser = choosesOnce({
        status: "ok",
        next: ["C", "not a ticket"],
        remaining: [],
      });

      const result = await implementSpec.run(sandbox, input({ chooser }));

      expect(result).toMatchObject({ status: "partial", merged: ["C"] });
      expect(result.stuck).toHaveLength(1);
      expect(result.stuck[0]?.ticket).toBe("not a ticket");
      expect(result.stuck[0]?.reason).toContain("can't name a session");
    });
  },
);
