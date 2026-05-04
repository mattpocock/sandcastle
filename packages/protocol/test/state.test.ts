import { describe, expect, it } from "vitest";
import {
  zCard,
  zDeck,
  zFleetState,
  zOperativeIdentity,
  zOperativeMicroState,
  zOperativeRepoRecord,
  zPhase,
  zPlanet,
  zProviderId,
  zRegisteredRepo,
  zRepoTelemetry,
  zRun,
  zRunStatus,
} from "../src/index.js";

const mode = {
  id: "mode-default",
  type: "mode" as const,
  slug: "default",
  title: "Default Mode",
  summary: "Operate safely",
  sourcePath: ".sandcastle/agents.md",
  enabled: true,
  tags: ["safe"],
  body: "Be helpful.",
  updatedAt: "2026-01-01T00:00:00.000Z",
  constraints: ["run tests"],
};

const skill = {
  id: "skill-tests",
  type: "skill" as const,
  slug: "tests",
  title: "Testing",
  summary: "Writes tests",
  sourcePath: ".sandcastle/skills/tests.md",
  enabled: true,
  tags: ["test"],
  body: "Prefer vitest.",
  updatedAt: "2026-01-01T00:00:00.000Z",
  passive: true as const,
  triggerHints: ["test"],
};

const command = {
  id: "command-fix",
  type: "command" as const,
  slug: "fix",
  title: "Fix",
  summary: "Fix a bug",
  sourcePath: ".sandcastle/commands/fix.md",
  enabled: true,
  tags: ["bug"],
  body: "Fix it.",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slashCommand: "/fix" as const,
  argsSchema: { issue: "string" },
  verifyHints: ["npm test"],
};

const deck = {
  version: 1 as const,
  mode,
  skills: [skill],
  commands: [command],
  order: [mode.id, skill.id, command.id],
};

const registeredRepo = {
  id: "repo_123",
  root: "/repo",
  addedAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-02T00:00:00.000Z",
};

const operative = {
  id: "pi-default",
  codename: "Pi Default",
  provider: "pi" as const,
  model: "pi",
  species: "synthetic",
  className: "Surgeon",
  level: 1,
  globalXp: 0,
  bond: 0,
  streak: 0,
  concurrencyCap: 1,
  sleeveCardIds: [],
  unlockedTraits: [],
};

const repoRecord = {
  operativeId: "pi-default",
  planetId: "planet-local",
  firstLandedAt: "2026-01-01T00:00:00.000Z",
  lastLandedAt: "2026-01-01T00:00:00.000Z",
  runIds: ["run_123"],
  victoriesCount: 1,
  defeatsCount: 0,
  planetSpecificBond: 0,
  scarsEarnedHere: [],
};

const planet = {
  id: "planet-local",
  repoName: "sandcastle",
  repoRoot: "/repo",
  defaultBranch: "main",
  terraformStage: 0,
  scars: [],
  wards: [],
  deck,
  telemetry: {
    coveragePct: null,
    ciGreenRate30d: null,
    openIssues: null,
    churnScore: null,
    ageDays: null,
    testCount: null,
    branch: "main",
    lastCommitAt: "2026-01-01T00:00:00.000Z",
    lastIndexedAt: null,
  },
  activeRunIds: ["run_123"],
  lastRunAt: "2026-01-01T00:00:00.000Z",
};

const phase = {
  id: "phase_1",
  runId: "run_123",
  ordinal: 1,
  title: "Implement",
  directiveSlice: "Do it",
  objective: "Done",
  xpEstimate: 10,
  verifyRules: ["npm test"],
  status: "active" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
};

const run = {
  id: "run_123",
  planetId: "planet-local",
  operativeId: "pi-default",
  provider: "pi" as const,
  sandboxProvider: "no-sandbox",
  status: "casting" as const,
  directive: "Do it",
  branch: "main",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
  phaseIds: [phase.id],
  currentPhaseId: phase.id,
  verification: { allGreen: false, failedChecks: [] },
  totals: { toolCalls: 1, filesEdited: 0, commandsRun: 1 },
};

const fleet = {
  planetsById: { [planet.id]: planet },
  operativesById: { [operative.id]: { ...operative, repoRecord } },
  runsById: { [run.id]: run },
  phasesById: { [phase.id]: phase },
  dockOrder: [run.id],
  pendingDecisions: [{ runId: run.id, kind: "merge" as const }],
  capacity: { used: 1, max: 1 },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("state schemas", () => {
  it("round-trips enum fixtures", () => {
    expect(zProviderId.parse("pi")).toBe("pi");
    expect(zRunStatus.parse("casting")).toBe("casting");
    expect(zOperativeMicroState.parse("crit")).toBe("crit");
  });

  it("round-trips card and deck fixtures", () => {
    expect(zCard.parse(mode)).toEqual(mode);
    expect(zCard.parse(skill)).toEqual(skill);
    expect(zCard.parse(command)).toEqual(command);
    expect(zDeck.parse(deck)).toEqual(deck);
  });

  it("round-trips operative fixtures", () => {
    expect(zRegisteredRepo.parse(registeredRepo)).toEqual(registeredRepo);
    expect(zOperativeIdentity.parse(operative)).toEqual(operative);
    expect(zOperativeRepoRecord.parse(repoRecord)).toEqual(repoRecord);
    expect(zRepoTelemetry.parse(planet.telemetry)).toEqual(planet.telemetry);
  });

  it("round-trips planet, phase, run, and fleet fixtures", () => {
    expect(zPlanet.parse(planet)).toEqual(planet);
    expect(zPhase.parse(phase)).toEqual(phase);
    expect(zRun.parse(run)).toEqual(run);
    expect(zFleetState.parse(fleet)).toEqual(fleet);
  });
});
