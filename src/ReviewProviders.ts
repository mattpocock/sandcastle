import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import {
  migrateRoleConfig,
  roleConfigRevision,
  roleSetting,
  type RoleConfig,
  type RoleTarget,
} from "./Operator.js";

/** Providers a role may run on: its primary followed by every fallback. */
export const roleProviderSet = (
  config: RoleConfig,
  role: "implementer" | "reviewer",
) => {
  const setting = roleSetting(config, role);
  return [setting, ...setting.fallback].map((target) => target.provider);
};

/**
 * Explain why the reviewer may share a provider with the implementer, or null
 * when every possible reviewer provider differs from every possible
 * implementer provider (fallbacks included).
 */
export const reviewProviderConflict = (config: RoleConfig): string | null => {
  const implementer = roleProviderSet(config, "implementer");
  const reviewer = roleProviderSet(config, "reviewer");
  const shared = [
    ...new Set(reviewer.filter((provider) => implementer.includes(provider))),
  ];
  if (shared.length === 0) return null;
  return (
    `review.requireDifferentProvider: reviewer and implementer can both run on ${shared.join(", ")} ` +
    `(implementer: ${implementer.join(" -> ")}; reviewer: ${reviewer.join(" -> ")}). ` +
    "Choose a different reviewer provider, remove the shared fallback in .sandcastle/roles.json, " +
    "or turn off the review policy in .sandcastle/workflow.json."
  );
};

/** Default reviewer used by the cross-provider review preset. */
export const crossProviderReviewer: RoleTarget = {
  provider: "claudeCode",
  model: "claude-opus-5-5",
  effort: "high",
};

/**
 * Cross-provider review preset: keeps every other role unchanged and sets the
 * reviewer to `reviewer` (Claude Code by default). If the implementer already
 * uses that provider, Codex is used instead. Returns a version-two document.
 */
export const applyCrossProviderReviewPreset = (
  config: RoleConfig,
  reviewer: RoleTarget = crossProviderReviewer,
): RoleConfig => {
  const v2 = migrateRoleConfig(config) as Extract<
    RoleConfig,
    { schemaVersion: 2 }
  >;
  const implementer = roleProviderSet(v2, "implementer");
  const target: RoleTarget = !implementer.includes(reviewer.provider)
    ? reviewer
    : { provider: "codex", model: "gpt-6.1-sol", effort: "high" };
  const roles = { ...v2.roles, reviewer: { ...target } };
  return {
    schemaVersion: 2,
    roles,
    revision: roleConfigRevision({ schemaVersion: 2, roles }),
  };
};

/** Outcome of making repository instructions visible to Claude Code. */
export type InstructionsResult =
  | "not-needed"
  | "created"
  | "already-linked"
  | "no-agents-md"
  | "claude-md-unlinked";

/**
 * Codex, OpenCode, pi, Copilot and Cursor read AGENTS.md; Claude Code reads
 * CLAUDE.md. When a role can run on Claude Code and the project has AGENTS.md
 * but no CLAUDE.md, create a CLAUDE.md that imports AGENTS.md (no duplicated
 * content). An existing CLAUDE.md is never modified.
 */
export const ensureProviderInstructionsEffect = (
  cwd: string,
  config: RoleConfig,
) =>
  Effect.gen(function* () {
    const usesClaude = (
      ["planner", "implementer", "reviewer", "merger", "readiness"] as const
    ).some((role) => {
      const setting = roleSetting(config, role);
      return [setting, ...setting.fallback].some(
        (target) => target.provider === "claudeCode",
      );
    });
    if (!usesClaude) return "not-needed" as InstructionsResult;
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(join(cwd, "AGENTS.md"))))
      return "no-agents-md" as InstructionsResult;
    const claudePath = join(cwd, "CLAUDE.md");
    if (yield* fs.exists(claudePath)) {
      const text = yield* fs.readFileString(claudePath);
      return (
        /@AGENTS\.md\b/.test(text) ? "already-linked" : "claude-md-unlinked"
      ) as InstructionsResult;
    }
    yield* fs.writeFileString(
      claudePath,
      "<!-- Created by Sandcastle: Claude Code reads CLAUDE.md; the project instructions live in AGENTS.md. -->\n@AGENTS.md\n",
    );
    return "created" as InstructionsResult;
  });

/** Promise API for host automation; see ensureProviderInstructionsEffect. */
export const ensureProviderInstructions = (options: {
  /** Host project directory. */
  cwd: string;
  /** Saved role configuration. */
  config: RoleConfig;
}): Promise<InstructionsResult> =>
  Effect.runPromise(
    ensureProviderInstructionsEffect(options.cwd, options.config).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
