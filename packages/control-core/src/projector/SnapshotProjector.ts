import type { FleetState, Planet, Run } from "@sandcastle/protocol";
import { DeckLoader } from "../deck/DeckLoader.js";
import { OperativeStore } from "../operatives/OperativeStore.js";
import type { RepoRegistry } from "../repos/RepoRegistry.js";
import type { RunSupervisor } from "../runs/RunSupervisor.js";
import { SqliteStore } from "../telemetry/SqliteStore.js";
import { TelemetryIndexer } from "../telemetry/TelemetryIndexer.js";

export class SnapshotProjector {
  constructor(
    private readonly repoRegistry: RepoRegistry,
    private readonly runSupervisor: RunSupervisor,
    private readonly deckLoader = new DeckLoader(),
    private readonly operativeStore = new OperativeStore(),
  ) {}

  async getFleetState(): Promise<FleetState> {
    const repo = await this.repoRegistry.getRepo();
    const repos = this.repoRegistry.listRepos();
    const runs = this.runSupervisor.listRuns();
    const runsById = Object.fromEntries(runs.map((run) => [run.id, run]));
    const activeRunIds = runs
      .filter((run) => !["victory", "defeat", "aborted"].includes(run.status))
      .map((run) => run.id);
    const planets = await Promise.all(
      repos.map(async (registered) => {
        const isCurrent = registered.id === repo.id;
        const store = new SqliteStore(registered.root);
        try {
          const telemetry = await new TelemetryIndexer(store).getTelemetry(
            registered,
          );
          const planet: Planet = {
            id: isCurrent ? "planet-local" : registered.id,
            repoName: registered.root.split(/[\\/]/).at(-1) ?? registered.root,
            repoRoot: registered.root,
            defaultBranch: isCurrent
              ? repo.branch
              : (telemetry.branch ?? "unknown"),
            terraformStage: 0,
            scars: [],
            wards: [],
            deck: this.deckLoader.loadDeck(registered.root),
            telemetry,
            activeRunIds: isCurrent ? activeRunIds : [],
            lastRunAt: isCurrent ? (runs.at(-1)?.startedAt ?? null) : null,
          };
          return planet;
        } finally {
          store.close();
        }
      }),
    );
    const operatives = this.operativeStore.listIdentities();
    const operativesById = Object.fromEntries(
      operatives.map((identity) => {
        const repoRecord = this.operativeStore.getRepoRecord(
          repo.root,
          identity.id,
        );
        return [
          identity.id,
          repoRecord ? { ...identity, repoRecord } : identity,
        ];
      }),
    );
    const maxCapacity = operatives.reduce(
      (max, identity) => max + identity.concurrencyCap,
      0,
    );

    return {
      planetsById: Object.fromEntries(
        planets.map((planet) => [planet.id, planet]),
      ),
      operativesById,
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
      capacity: { used: activeRunIds.length, max: maxCapacity },
      updatedAt: new Date().toISOString(),
    };
  }
}
