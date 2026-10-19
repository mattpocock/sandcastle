import { expect, test } from "vitest";
import {
  formatReviewFindings,
  parseReviewVerdict,
  runReviewLoop,
  type ReviewFinding,
  type ReviewLoopRun,
} from "./ReviewLoop.js";

const COMPLETE = "<promise>COMPLETE</promise>";
const BLOCKED = "<promise>BLOCKED</promise>";
const verdict = (value: unknown, signal = COMPLETE) =>
  `Review ledger...\n<review-verdict>${JSON.stringify(value)}</review-verdict>\n${signal}`;
const finding: ReviewFinding = {
  id: "F1",
  severity: "major",
  file: "src/a.ts",
  line: 4,
  change: "Handle empty input",
};
const approve = { verdict: "approve", summary: "ok", findings: [] };
const changes = { verdict: "changes-requested", findings: [finding] };
const run = (
  stdout: string,
  sha?: string,
  completionSignal?: string,
): ReviewLoopRun => ({
  stdout,
  commits: sha ? [{ sha }] : [],
  completionSignal:
    completionSignal ??
    (stdout.includes(BLOCKED)
      ? BLOCKED
      : stdout.includes(COMPLETE)
        ? COMPLETE
        : undefined),
});
const script = (reviews: ReviewLoopRun[], repairs: ReviewLoopRun[] = []) => {
  const calls: string[] = [];
  const seen: unknown[] = [];
  return {
    calls,
    seen,
    review: async (round: number) => {
      calls.push(`review:${round}`);
      return reviews.shift()!;
    },
    repair: async (findings: readonly unknown[], round: number) => {
      calls.push(`repair:${round}`);
      seen.push(findings);
      return repairs.shift() ?? run(COMPLETE, `repair-${round}`);
    },
  };
};

test("approve on the first pass merges without a repair", async () => {
  const s = script([run(verdict(approve), "r1")]);
  const result = await runReviewLoop({ review: s.review, repair: s.repair });
  expect(result.outcome).toBe("approved");
  expect(s.calls).toEqual(["review:1"]);
  expect(result.commits).toEqual([{ sha: "r1" }]);
});

test("changes-requested runs a repair with the structured findings, then re-reviews to approval", async () => {
  const s = script([run(verdict(changes)), run(verdict(approve))]);
  const result = await runReviewLoop({ review: s.review, repair: s.repair });
  expect(result.outcome).toBe("approved");
  expect(s.calls).toEqual(["review:1", "repair:1", "review:2"]);
  expect(s.seen).toEqual([[finding]]);
  expect(result.rounds.map((r) => [r.verdict, r.repaired])).toEqual([
    ["changes-requested", true],
    ["approve", false],
  ]);
  expect(result.commits).toEqual([{ sha: "repair-1" }]);
});

test("an exhausted budget retains findings and does not approve", async () => {
  const s = script([
    run(verdict(changes)),
    run(verdict(changes)),
    run(verdict(changes)),
  ]);
  const result = await runReviewLoop({
    maxRepairRounds: 2,
    review: s.review,
    repair: s.repair,
  });
  expect(result.outcome).toBe("changes-requested");
  expect(s.calls).toEqual([
    "review:1",
    "repair:1",
    "review:2",
    "repair:2",
    "review:3",
  ]);
  expect(result.findings).toEqual([finding]);
});

test("blocked verdicts, blocked signals and blocked repairs stop without approval", async () => {
  for (const reviews of [
    [run(verdict({ verdict: "blocked", findings: [] }))],
    [run(verdict(approve, BLOCKED))],
  ]) {
    const s = script(reviews);
    expect(
      (await runReviewLoop({ review: s.review, repair: s.repair })).outcome,
    ).toBe("blocked");
  }
  const s = script([run(verdict(changes))], [run(BLOCKED)]);
  const result = await runReviewLoop({ review: s.review, repair: s.repair });
  expect(result.outcome).toBe("blocked");
  expect(s.calls).toEqual(["review:1", "repair:1"]);
});

test("malformed or missing reviewer output fails closed", async () => {
  for (const stdout of [
    COMPLETE,
    `<review-verdict>{not json</review-verdict>${COMPLETE}`,
    verdict({ verdict: "changes-requested", findings: [] }),
    verdict({ verdict: "approve", findings: [finding] }),
    verdict({ verdict: "approve", findings: [], extra: 1 }),
    verdict({ ...changes, findings: [finding, finding] }),
  ]) {
    const s = script([run(stdout)]);
    const result = await runReviewLoop({ review: s.review, repair: s.repair });
    expect(result.outcome, stdout).toBe("invalid-review");
    expect(s.calls).toEqual(["review:1"]);
  }
  const noSignal = script([run(verdict(approve, ""), undefined, undefined)]);
  expect(
    (await runReviewLoop({ review: noSignal.review, repair: noSignal.repair }))
      .outcome,
  ).toBe("invalid-review");
});

test("zero repair rounds keeps single-pass review compatible with plain completion", async () => {
  const legacy = script([run(`Repaired in place. ${COMPLETE}`, "in-review")]);
  const result = await runReviewLoop({
    maxRepairRounds: 0,
    review: legacy.review,
    repair: legacy.repair,
  });
  expect(result.outcome).toBe("approved");
  expect(result.commits).toEqual([{ sha: "in-review" }]);
  const changed = script([run(verdict(changes))]);
  expect(
    (
      await runReviewLoop({
        maxRepairRounds: 0,
        review: changed.review,
        repair: changed.repair,
      })
    ).outcome,
  ).toBe("changes-requested");
  expect(changed.calls).toEqual(["review:1"]);
  await expect(
    runReviewLoop({
      maxRepairRounds: -1,
      review: legacy.review,
      repair: legacy.repair,
    }),
  ).rejects.toThrow(RangeError);
});

test("verdict parsing takes the last tag and findings render as repair input", async () => {
  const stdout = `${verdict(changes)}\nlater\n${verdict(approve)}`;
  expect((await parseReviewVerdict(stdout)).verdict).toBe("approve");
  expect(
    formatReviewFindings([
      finding,
      { id: "F2", severity: "minor", change: "Rename x" },
    ]),
  ).toBe(
    "- [F1] (major) src/a.ts:4: Handle empty input\n- [F2] (minor): Rename x",
  );
});
