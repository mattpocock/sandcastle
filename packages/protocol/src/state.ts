import { z } from "zod";

export const zProviderId = z.enum(["claude-code", "codex", "pi", "opencode"]);
export type ProviderId = z.infer<typeof zProviderId>;

export const zCardType = z.enum(["mode", "skill", "command"]);
export type CardType = z.infer<typeof zCardType>;

export const zRunStatus = z.enum([
  "queued",
  "starting",
  "casting",
  "striking",
  "verifying",
  "win-pending",
  "fail-pending",
  "victory",
  "defeat",
  "aborted",
]);
export type RunStatus = z.infer<typeof zRunStatus>;

export const zOperativeMicroState = z.enum([
  "idle",
  "casting",
  "striking",
  "crit",
  "hit",
]);
export type OperativeMicroState = z.infer<typeof zOperativeMicroState>;

const zCardBase = z.object({
  id: z.string(),
  type: zCardType,
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  sourcePath: z.string(),
  enabled: z.boolean(),
  tags: z.array(z.string()),
  body: z.string(),
  updatedAt: z.string(),
});

export const zModeCard = zCardBase.extend({
  type: z.literal("mode"),
  constraints: z.array(z.string()),
});
export type ModeCard = z.infer<typeof zModeCard>;

export const zSkillCard = zCardBase.extend({
  type: z.literal("skill"),
  passive: z.literal(true),
  triggerHints: z.array(z.string()),
});
export type SkillCard = z.infer<typeof zSkillCard>;

export const zCommandCard = zCardBase.extend({
  type: z.literal("command"),
  slashCommand: z.string().regex(/^\//),
  argsSchema: z.record(z.string()).optional(),
  verifyHints: z.array(z.string()),
});
export type CommandCard = z.infer<typeof zCommandCard>;

export const zCard = z.discriminatedUnion("type", [
  zModeCard,
  zSkillCard,
  zCommandCard,
]);
export type Card = z.infer<typeof zCard>;

export const zDeck = z.object({
  version: z.literal(1),
  mode: zModeCard,
  skills: z.array(zSkillCard),
  commands: z.array(zCommandCard),
  order: z.array(z.string()),
});
export type Deck = z.infer<typeof zDeck>;

export const zRegisteredRepo = z.object({
  id: z.string(),
  root: z.string(),
  addedAt: z.string(),
  lastOpenedAt: z.string(),
});
export type RegisteredRepo = z.infer<typeof zRegisteredRepo>;

export const zOperativeIdentity = z.object({
  id: z.string(),
  codename: z.string(),
  provider: zProviderId,
  model: z.string(),
  species: z.string(),
  className: z.string(),
  level: z.number(),
  globalXp: z.number(),
  bond: z.number(),
  streak: z.number(),
  concurrencyCap: z.number(),
  sleeveCardIds: z.array(z.string()),
  unlockedTraits: z.array(z.string()),
});
export type OperativeIdentity = z.infer<typeof zOperativeIdentity>;

export const zOperativeRepoRecord = z.object({
  operativeId: z.string(),
  planetId: z.string(),
  firstLandedAt: z.string(),
  lastLandedAt: z.string(),
  runIds: z.array(z.string()),
  victoriesCount: z.number(),
  defeatsCount: z.number(),
  planetSpecificBond: z.number(),
  scarsEarnedHere: z.array(z.string()),
});
export type OperativeRepoRecord = z.infer<typeof zOperativeRepoRecord>;

export const zRepoTelemetry = z.object({
  coveragePct: z.number().nullable(),
  ciGreenRate30d: z.number().nullable(),
  openIssues: z.number().nullable(),
  churnScore: z.number().nullable(),
  ageDays: z.number().nullable(),
  testCount: z.number().nullable(),
  branch: z.string().nullable(),
  lastCommitAt: z.string().nullable(),
  lastIndexedAt: z.string().nullable(),
});
export type RepoTelemetry = z.infer<typeof zRepoTelemetry>;

export const zPlanet = z.object({
  id: z.string(),
  repoName: z.string(),
  repoRoot: z.string(),
  defaultBranch: z.string(),
  terraformStage: z.number(),
  scars: z.array(z.string()),
  wards: z.array(z.string()),
  deck: zDeck,
  telemetry: zRepoTelemetry,
  activeRunIds: z.array(z.string()),
  lastRunAt: z.string().nullable(),
});
export type Planet = z.infer<typeof zPlanet>;

export const zPhase = z.object({
  id: z.string(),
  runId: z.string(),
  ordinal: z.number(),
  title: z.string(),
  directiveSlice: z.string(),
  objective: z.string(),
  xpEstimate: z.number(),
  verifyRules: z.array(z.string()),
  status: z.enum(["pending", "active", "verified", "failed", "skipped"]),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type Phase = z.infer<typeof zPhase>;

export const zRun = z.object({
  id: z.string(),
  planetId: z.string(),
  operativeId: z.string(),
  provider: zProviderId,
  sandboxProvider: z.string(),
  status: zRunStatus,
  directive: z.string(),
  branch: z.string(),
  worktreePath: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  phaseIds: z.array(z.string()),
  currentPhaseId: z.string().nullable(),
  verification: z.object({
    allGreen: z.boolean(),
    failedChecks: z.array(z.string()),
  }),
  totals: z.object({
    toolCalls: z.number(),
    filesEdited: z.number(),
    commandsRun: z.number(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
  }),
});
export type Run = z.infer<typeof zRun>;

export const zFleetState = z.object({
  planetsById: z.record(zPlanet),
  operativesById: z.record(
    zOperativeIdentity.extend({ repoRecord: zOperativeRepoRecord.optional() }),
  ),
  runsById: z.record(zRun),
  phasesById: z.record(zPhase),
  dockOrder: z.array(z.string()),
  pendingDecisions: z.array(
    z.object({
      runId: z.string(),
      kind: z.enum(["merge", "revise", "replay", "discard", "recover"]),
    }),
  ),
  capacity: z.object({ used: z.number(), max: z.number() }),
  updatedAt: z.string(),
});
export type FleetState = z.infer<typeof zFleetState>;
