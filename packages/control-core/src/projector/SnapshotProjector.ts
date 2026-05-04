import type {
  Deck,
  FleetState,
  OperativeIdentity,
  Planet,
  Run,
} from "@sandcastle/protocol";
import type { RepoRegistry } from "../repos/RepoRegistry.js";
import type { RunSupervisor } from "../runs/RunSupervisor.js";

const emptyMode = {
  id: "mode-default",
  type: "mode" as const,
  slug: "default",
  title: "Default Mode",
  summary: "Phase 0 synthetic mode",
  sourcePath: ".sandcastle/agents.md",
  enabled: true,
  tags: [],
  body: "",
  updatedAt: new Date(0).toISOString(),
  constraints: [],
};

const emptyDeck: Deck = {
  version: 1,
  mode: emptyMode,
  skills: [],
  commands: [],
  order: [emptyMode.id],
};

const operative: OperativeIdentity = {
  id: "pi-default",
  codename: "Pi Default",
  provider: "pi",
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

export class SnapshotProjector {
  constructor(
    private readonly repoRegistry: RepoRegistry,
    private readonly runSupervisor: RunSupervisor,
  ) {}

  async getFleetState(): Promise<FleetState> {
    const repo = await this.repoRegistry.getRepo();
    const runs = this.runSupervisor.listRuns();
    const runsById = Object.fromEntries(runs.map((run) => [run.id, run]));
    const activeRunIds = runs
      .filter((run) => !["victory", "defeat", "aborted"].includes(run.status))
      .map((run) => run.id);
    const planet: Planet = {
      id: "planet-local",
      repoName: repo.repoName,
      repoRoot: repo.root,
      defaultBranch: repo.branch,
      terraformStage: 0,
      scars: [],
      wards: [],
      deck: emptyDeck,
      telemetry: {
        coveragePct: null,
        ciGreenRate30d: null,
        openIssues: null,
        churnScore: null,
        ageDays: null,
        testCount: null,
        lastIndexedAt: null,
      },
      activeRunIds,
      lastRunAt: runs.at(-1)?.startedAt ?? null,
    };

    return {
      planetsById: { [planet.id]: planet },
      operativesById: { [operative.id]: operative },
      runsById: runsById as Record<string, Run>,
      phasesById: {},
      dockOrder: runs.map((run) => run.id),
      pendingDecisions: runs
        .filter(
          (run) =>
            run.status === "win-pending" || run.status === "fail-pending",
        )
        .map((run) => ({
          runId: run.id,
          kind:
            run.status === "win-pending"
              ? ("merge" as const)
              : ("revise" as const),
        })),
      capacity: { used: activeRunIds.length, max: operative.concurrencyCap },
      updatedAt: new Date().toISOString(),
    };
  }
}
