import type { JSX } from "react";
import { useMemo } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Ban, GitBranch, ScrollText } from "lucide-react";
import { useCancelRun, useRun } from "../api/queries";
import { CockpitTimeline } from "../primitives/CockpitTimeline";
import { StatusPill } from "../primitives/StatusPill";
import { useFleetStore } from "../state/fleetStore";

const terminal = new Set(["victory", "defeat", "aborted"]);

export function CockpitRoute(): JSX.Element {
  const { runId } = useParams();
  if (!runId) return <Navigate to="/" replace />;
  return <CockpitContent runId={runId} />;
}

function CockpitContent({ runId }: { readonly runId: string }): JSX.Element {
  const { data: fetchedRun, isLoading, error } = useRun(runId);
  const storeRun = useFleetStore((state) => state.fleet?.runsById[runId]);
  const events = useFleetStore((state) => state.runEvents[runId] ?? []);
  const cancelRun = useCancelRun(runId);
  const run = storeRun ?? fetchedRun;
  const grouped = useMemo(
    () => ({
      text: events.filter((event) => event.type === "text").length,
      tools: events.filter(
        (event) => event.type === "tool.started" || event.type === "toolCall",
      ).length,
    }),
    [events],
  );

  if (isLoading && !run) {
    return <div className="panel cockpit-placeholder">Loading run {runId}</div>;
  }

  if (error && !run) {
    return (
      <div className="panel cockpit-placeholder">
        Run not found: {error.message}
      </div>
    );
  }

  if (!run) {
    return (
      <div className="panel cockpit-placeholder">
        Waiting for run snapshot {runId}
      </div>
    );
  }

  const canCancel = !terminal.has(run.status);

  return (
    <section className="cockpit-layout">
      <aside className="panel run-sidebar">
        <div className="eyebrow">directive</div>
        <h2>{run.directive}</h2>
        <dl className="run-facts">
          <div>
            <dt>Run</dt>
            <dd>{run.id}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>
              <GitBranch size={13} /> {run.branch}
            </dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>{grouped.tools}</dd>
          </div>
          <div>
            <dt>Text packets</dt>
            <dd>{grouped.text}</dd>
          </div>
        </dl>
      </aside>

      <div className="panel cockpit-stage">
        <header className="cockpit-head">
          <div>
            <div className="eyebrow">live timeline</div>
            <h1>
              <ScrollText size={22} /> {run.id}
            </h1>
          </div>
          <div className="cockpit-actions">
            <StatusPill status={run.status} />
            <button
              className="danger-action"
              type="button"
              onClick={() => cancelRun.mutate()}
              disabled={!canCancel || cancelRun.isPending}
            >
              <Ban size={15} />
              Cancel
            </button>
          </div>
        </header>
        <CockpitTimeline events={events} />
      </div>
    </section>
  );
}
