import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fail, gh, required, writeJson } from "../shared/common";
import {
  EXPLORE_LABEL,
  parseBatch,
  planEffects,
  planSchema,
  validate,
  VERDICT_LABEL,
} from "./batch";
import type { GitHubEffect, Plan } from "./batch";

/**
 * Deterministic effects step for batch explore. Validates the agent's whole
 * plan before touching anything; on any problem it changes nothing, leaves
 * every label in place, and fails the run so the next run retries.
 *
 * The agent never runs in this job: it only ever sees a JSON plan, and every
 * GitHub write goes through the fixed vocabulary in `planEffects`.
 */

const BATCH_FILE = required("BATCH_FILE");
const PLAN_FILE = required("PLAN_FILE");
const GH_REPO = required("GH_REPO");
const DRY_RUN = process.env.DRY_RUN === "true";
const AGENT_PAT = process.env.AGENT_PAT ?? "";

const summary = (markdown: string): void => {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    fs.appendFileSync(file, `${markdown}\n`);
  } else {
    console.log(markdown);
  }
};

const refuse = (reason: string): never => {
  summary(
    `## Batch explore refused\n\nNo issues were changed; every \`${EXPLORE_LABEL}\` label is still in place.\n\n**Reason:** ${reason}`,
  );
  return fail(`Refused to apply plan: ${reason}`);
};

const ghWith = (args: string[], options: { token?: string; input?: string }) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
    env: options.token
      ? { ...process.env, GH_TOKEN: options.token }
      : undefined,
  });

const outcome = (entry: Plan["issues"][number]): string =>
  entry.duplicate_of === null
    ? `\`${EXPLORE_LABEL}\` → \`${VERDICT_LABEL[entry.tag]}\``
    : `closed as duplicate of #${entry.duplicate_of}`;

const describe = (effect: GitHubEffect): string => {
  switch (effect.kind) {
    case "comment": {
      return `#${effect.issue}: comment`;
    }
    case "swap-label": {
      return `#${effect.issue}: swap \`${EXPLORE_LABEL}\` → \`${effect.to}\``;
    }
    case "close-duplicate": {
      return `#${effect.issue}: remove \`${EXPLORE_LABEL}\`, close as duplicate of #${effect.duplicateOf}`;
    }
  }
};

const apply = (effect: GitHubEffect): void => {
  const issue = String(effect.issue);
  switch (effect.kind) {
    case "comment": {
      ghWith(["issue", "comment", issue, "--body-file", "-"], {
        input: effect.body,
      });
      return;
    }
    case "swap-label": {
      if (effect.to === "agent:implement" && !AGENT_PAT) {
        console.log(
          `::warning::AGENT_PAT is not set; adding agent:implement to #${issue} with GITHUB_TOKEN will not trigger Agent Implement.`,
        );
      }
      ghWith(
        [
          "issue",
          "edit",
          issue,
          "--remove-label",
          EXPLORE_LABEL,
          "--add-label",
          effect.to,
        ],
        // A label added with GITHUB_TOKEN does not trigger other workflows,
        // so the hand-off to agent:implement must go through AGENT_PAT.
        { token: effect.to === "agent:implement" ? AGENT_PAT : undefined },
      );
      return;
    }
    case "close-duplicate": {
      ghWith(["issue", "edit", issue, "--remove-label", EXPLORE_LABEL], {});
      try {
        ghWith(
          [
            "api",
            "--method",
            "PATCH",
            `repos/${GH_REPO}/issues/${issue}`,
            "-f",
            "state=closed",
            "-f",
            "state_reason=duplicate",
          ],
          {},
        );
      } catch {
        ghWith(["issue", "close", issue, "--reason", "not planned"], {});
      }
    }
  }
};

const readJson = (file: string, label: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return refuse(
      `could not read ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const batch = parseBatch(readJson(BATCH_FILE, "batch file"));

let plan: Plan;
try {
  plan = validate(planSchema(batch), readJson(PLAN_FILE, "plan file"));
} catch (error) {
  plan = refuse(
    `plan failed validation: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Every issue must still be open and still carry agent:explore — if a human
// moved one on mid-run, don't overwrite their decision.
const live = new Set(
  (
    JSON.parse(
      gh([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        EXPLORE_LABEL,
        "--limit",
        "1000",
        "--json",
        "number",
      ]),
    ) as { number: number }[]
  ).map((issue) => issue.number),
);
const stale = plan.issues.filter((entry) => !live.has(entry.number));
if (stale.length > 0) {
  refuse(
    `no longer open with \`${EXPLORE_LABEL}\`: ${stale.map((e) => `#${e.number}`).join(", ")}`,
  );
}

const effects = planEffects(plan);

summary(
  [
    `## Batch explore${DRY_RUN ? " (dry run — nothing changed)" : ""}`,
    "",
    "| Issue | Tag | Outcome |",
    "| --- | --- | --- |",
    ...[...plan.issues]
      .sort((a, b) => a.number - b.number)
      .map(
        (entry) =>
          `| #${entry.number} | \`${entry.tag}\` | ${outcome(entry)} |`,
      ),
    ...(plan.patterns.trim()
      ? ["", "### Cross-group patterns", "", plan.patterns.trim()]
      : []),
  ].join("\n"),
);

if (DRY_RUN) {
  summary(
    [
      "",
      "### Planned effects",
      "",
      ...effects.flatMap((effect) =>
        effect.kind === "comment"
          ? [
              `<details><summary>${describe(effect)}</summary>`,
              "",
              effect.body,
              "",
              "</details>",
              "",
            ]
          : [`- ${describe(effect)}`, ""],
      ),
    ].join("\n"),
  );
  writeJson("effects.json", effects);
  console.log(
    `Dry run: ${effects.length} planned effect(s) written to summary.`,
  );
} else {
  for (const effect of effects) {
    try {
      apply(effect);
      console.log(`Applied ${describe(effect)}`);
    } catch (error) {
      fail(
        `Failed to apply ${describe(effect)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`Applied ${effects.length} effect(s).`);
}
