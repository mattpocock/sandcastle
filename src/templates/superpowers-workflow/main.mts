// Superpowers Workflow — full orchestration with skills-based development
//
// This template drives a multi-phase workflow incorporating superpowers skills:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Plan + Execute + Review):
//                               For each issue, a sandbox is created via
//                               createSandbox(). The superpowers workflow:
//                               1. Write detailed plan (writing-plans)
//                               2. Execute with subagents (subagent-driven-development)
//                               3. Use TDD (test-driven-development)
//                               4. Review code (requesting-code-review)
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch (finishing skill).
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Load .sandcastle/.env if it exists (ensures ANTHROPIC_* vars are in process.env)
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length > 0) {
      const value = rest.join("=").replace(/^["']|["']$/g, "");
      process.env[key.trim()] = value.trim();
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
const MAX_ITERATIONS = 10;

// Resolve the correct URL for Docker containers.
const dockerBaseUrl = process.env.ANTHROPIC_BASE_URL;

// Docker env: pass resolved URL + auth token into containers.
// claude-code inside the container expects ANTHROPIC_AUTH_TOKEN, not ANTHROPIC_API_KEY.
const dockerEnv: Record<string, string> = {};
if (dockerBaseUrl) dockerEnv.ANTHROPIC_BASE_URL = dockerBaseUrl;
if (process.env.ANTHROPIC_AUTH_TOKEN) {
  dockerEnv.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
} else if (process.env.ANTHROPIC_API_KEY) {
  dockerEnv.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_API_KEY;
}

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install / pip install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "npm install" },
      { command: "[ -f requirements.txt ] && command -v pip && pip install --break-system-packages -r requirements.txt" },
    ],
  },
};

// Copy node_modules, venv, .venv from the host into the worktree before each sandbox
// starts. Avoids a full install from scratch.
const copyToWorktree = ["node_modules", "venv", ".venv", "src"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — we parse that to drive Phase 2.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker({ env: dockerEnv, network: [] }),
    name: "planner",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-opus-4-6", { thinkingDisplay: "omitted" }),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  // Extract the <plan>...</plan> block from the agent's stdout.
  const endTagPos = plan.stdout.lastIndexOf('</plan>');
  if (endTagPos === -1) {
    throw new Error(
      "Planning agent did not produce a </plan> tag.\n\n" + plan.stdout
    );
  }
  const startTagPos = plan.stdout.lastIndexOf('<plan>', endTagPos);
  if (startTagPos === -1) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + plan.stdout
    );
  }



  // The plan JSON contains an array of issues, each with id, title, branch.
  // Agent may return raw JSON, JS-escaped string literal, or wrap JSON in
  // natural-language commentary — handle all cases.
  let planStr = plan.stdout.slice(startTagPos + 6, endTagPos).trim();
  let parsed: { issues: { id: string; title: string; branch: string }[] };

  // If the entire match is a JSON string (quoted), parse it to unwrap.
  if (planStr.startsWith('"') && planStr.endsWith('"')) {
    try {
      planStr = JSON.parse(planStr) as string;
    } catch {
      // Not a wrapped string — continue with original.
    }
  }

  // Extract valid JSON from possibly noisy LLM output (text before/after JSON).
  function extractJson(text: string): unknown {
    // Try the whole string first.
    try { return JSON.parse(text); } catch { }

    // Unescape JS string literals, then try again.
    const unescaped = text
      .replace(/\\\\/g, "\x00")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\x00/g, "\\");
    try { return JSON.parse(unescaped); } catch { }

    // Scan for JSON objects/arrays embedded in surrounding text.
    for (const open of ["{", "["]) {
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let start = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === open) {
          if (depth === 0) start = i;
          depth++;
        } else if (text[i] === close) {
          depth--;
          if (depth === 0 && start >= 0) {
            const candidate = text.slice(start, i + 1);
            try {
              const parsedCandidate = JSON.parse(candidate);
              // Return the first complete JSON value found (prefer top-level array).
              if (open === "[" && Array.isArray(parsedCandidate)) {
                return parsedCandidate;
              }
              return parsedCandidate;
            } catch {
              // Not valid JSON yet — keep scanning.
            }
          }
        }
      }
    }
    throw new Error("No valid JSON found in plan output");
  }

  parsed = extractJson(planStr) as typeof parsed;
  const { issues } = parsed;

  if (issues.length === 0) {
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Plan + Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the
  // superpowers workflow runs in an isolated environment on the issue branch.
  //
  // The implement-prompt.md runs the full superpowers workflow:
  // 1. Write detailed plan (writing-plans skill)
  // 2. Execute with subagents (subagent-driven-development skill)
  // 3. Use TDD (test-driven-development skill)
  // 4. Request code review (requesting-code-review skill)
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: docker({ env: dockerEnv, network: [] }),
        hooks,
        copyToWorktree,
      });

      try {
        // Run the full superpowers workflow
        const result = await sandbox.run({
          name: "superpowers-workflow",
          maxIterations: 100,
          agent: sandcastle.claudeCode("claude-opus-4-6", { thinkingDisplay: "omitted" }),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        return result;
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: docker({ env: dockerEnv, network: [] }),
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-opus-4-6", { thinkingDisplay: "omitted" }),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues
        .map((i) => `- ${i.id}: ${i.title}`)
        .join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
