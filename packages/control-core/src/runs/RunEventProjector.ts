import type { Run, RunEvent, RunStatus } from "@sandcastle/protocol";

const OPERATIVE_ID = "pi-default";
const PLANET_ID = "planet-local";

export class RunEventProjector {
  private readonly runs = new Map<string, Run>();

  createQueued(input: {
    readonly id: string;
    readonly directive: string;
    readonly branch: string;
    readonly provider?: Run["provider"];
    readonly sandboxProvider?: string;
    readonly startedAt?: string;
  }): Run {
    const existing = this.runs.get(input.id);
    if (existing) return existing;
    const run: Run = {
      id: input.id,
      planetId: PLANET_ID,
      operativeId: OPERATIVE_ID,
      provider: input.provider ?? "codex",
      sandboxProvider: input.sandboxProvider ?? "no-sandbox",
      status: "queued",
      directive: input.directive,
      branch: input.branch,
      startedAt: input.startedAt ?? new Date().toISOString(),
      endedAt: null,
      phaseIds: [],
      currentPhaseId: null,
      verification: { allGreen: false, failedChecks: [] },
      totals: { toolCalls: 0, filesEdited: 0, commandsRun: 0 },
    };
    this.runs.set(input.id, run);
    return run;
  }

  project(event: RunEvent, fallbackRunId?: string): Run | undefined {
    const runId = "runId" in event ? event.runId : fallbackRunId;
    if (!runId) return undefined;

    let run = this.runs.get(runId);
    if (event.type === "run.started") {
      run = this.createQueued({
        id: event.runId,
        directive: event.directive,
        branch: event.branch,
        startedAt: event.timestamp.toISOString(),
      });
      run = {
        ...run,
        status: "starting",
        directive: event.directive,
        branch: event.branch,
        worktreePath: event.worktreePath,
        startedAt: event.timestamp.toISOString(),
      };
      this.runs.set(runId, run);
      return run;
    }
    if (!run) return undefined;

    const transition = (status: RunStatus): void => {
      run = { ...run!, status };
    };

    switch (event.type) {
      case "run.statusChanged":
        transition(event.to);
        break;
      case "text":
      case "toolCall":
      case "tool.started":
        if (run.status === "queued" || run.status === "starting") {
          transition("casting");
        }
        if (event.type === "toolCall" || event.type === "tool.started") {
          run = {
            ...run!,
            totals: {
              ...run!.totals,
              toolCalls:
                run!.totals.toolCalls + (event.type === "tool.started" ? 1 : 0),
              commandsRun:
                event.name === "Bash" && event.type === "tool.started"
                  ? run!.totals.commandsRun + 1
                  : run!.totals.commandsRun,
            },
          };
        }
        break;
      case "verification.started":
        transition("verifying");
        break;
      case "verification.finished":
        run = {
          ...run,
          status: event.allGreen ? "win-pending" : "fail-pending",
          verification: {
            allGreen: event.allGreen,
            failedChecks: [...event.failedChecks],
          },
        };
        break;
      case "run.resolved":
        run = {
          ...run,
          status: event.result,
          endedAt: event.timestamp.toISOString(),
        };
        break;
      case "tool.finished":
      case "decision.required":
      case "intervention.used":
        break;
    }

    this.runs.set(runId, run);
    return run;
  }

  getRun(id: string): Run | undefined {
    return this.runs.get(id);
  }

  listRuns(): Run[] {
    return [...this.runs.values()];
  }
}
