import { create } from "zustand";
import type {
  FleetState,
  Run,
  RunEvent,
  WsServerMessage,
} from "@sandcastle/protocol";

type ConnectionState = "connecting" | "connected" | "closed";

interface FleetStore {
  readonly connectionState: ConnectionState;
  readonly fleet: FleetState | null;
  readonly runEvents: Record<string, RunEvent[]>;
  readonly applyServerMessage: (message: WsServerMessage) => void;
  readonly setConnectionState: (state: ConnectionState) => void;
}

const terminalStatuses = new Set(["victory", "defeat", "aborted"]);

export const useFleetStore = create<FleetStore>((set) => ({
  connectionState: "connecting",
  fleet: null,
  runEvents: {},

  setConnectionState: (connectionState) => set({ connectionState }),

  applyServerMessage: (message) => {
    if (message.type === "hello") {
      set({ connectionState: "connected" });
      return;
    }

    if (message.type === "fleet.snapshot") {
      set({ fleet: message.payload });
      return;
    }

    if (message.type === "run.event") {
      set((state) => {
        const nextEvents = {
          ...state.runEvents,
          [message.runId]: [
            ...(state.runEvents[message.runId] ?? []),
            message.event,
          ],
        };

        const nextFleet = state.fleet
          ? projectFleetEvent(state.fleet, message.runId, message.event)
          : state.fleet;

        return { runEvents: nextEvents, fleet: nextFleet };
      });
    }
  },
}));

const projectFleetEvent = (
  fleet: FleetState,
  runId: string,
  event: RunEvent,
): FleetState => {
  const existing = fleet.runsById[runId];
  const run = projectRun(existing, runId, event);
  if (!run) return fleet;

  const runsById = { ...fleet.runsById, [runId]: run };
  const dockOrder = fleet.dockOrder.includes(runId)
    ? fleet.dockOrder
    : [...fleet.dockOrder, runId];
  const active = Object.values(runsById).filter(
    (candidate) => !terminalStatuses.has(candidate.status),
  );

  return {
    ...fleet,
    runsById,
    dockOrder,
    capacity: { ...fleet.capacity, used: active.length },
    updatedAt: new Date().toISOString(),
  };
};

const projectRun = (
  run: Run | undefined,
  runId: string,
  event: RunEvent,
): Run | undefined => {
  if (event.type === "run.started") {
    return {
      id: runId,
      planetId: "planet-local",
      operativeId: "pi-default",
      provider: run?.provider ?? "codex",
      sandboxProvider: run?.sandboxProvider ?? "host-bind-mount",
      status: "starting",
      directive: event.directive,
      branch: event.branch,
      worktreePath: event.worktreePath,
      startedAt: event.timestamp.toISOString(),
      endedAt: null,
      phaseIds: [],
      currentPhaseId: null,
      verification: { allGreen: false, failedChecks: [] },
      totals: { toolCalls: 0, filesEdited: 0, commandsRun: 0 },
    };
  }

  if (!run) return undefined;

  if (event.type === "run.statusChanged") return { ...run, status: event.to };
  if (event.type === "run.resolved") {
    return {
      ...run,
      status: event.result,
      endedAt: event.timestamp.toISOString(),
    };
  }
  if (event.type === "verification.started")
    return { ...run, status: "verifying" };
  if (event.type === "verification.finished") {
    return {
      ...run,
      status: event.allGreen ? "win-pending" : "fail-pending",
      verification: {
        allGreen: event.allGreen,
        failedChecks: [...event.failedChecks],
      },
    };
  }
  if (event.type === "tool.started") {
    return {
      ...run,
      status:
        run.status === "queued" || run.status === "starting"
          ? "casting"
          : run.status,
      totals: {
        ...run.totals,
        toolCalls: run.totals.toolCalls + 1,
        commandsRun:
          event.name === "Bash"
            ? run.totals.commandsRun + 1
            : run.totals.commandsRun,
      },
    };
  }
  if (
    event.type === "text" &&
    (run.status === "queued" || run.status === "starting")
  ) {
    return { ...run, status: "casting" };
  }
  return run;
};
