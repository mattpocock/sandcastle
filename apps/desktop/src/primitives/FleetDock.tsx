import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { CheckCheck, Play } from "lucide-react";
import type { Run } from "@sandcastle/protocol";
import { useFleetStore } from "../state/fleetStore";
import { StatusPill } from "./StatusPill";
import styles from "./chrome.module.css";

export function FleetDock({
  onDeploy,
}: {
  readonly onDeploy: () => void;
}): JSX.Element {
  const fleet = useFleetStore((state) => state.fleet);
  const connectionState = useFleetStore((state) => state.connectionState);
  const { runId } = useParams();
  const runs: Run[] = fleet
    ? fleet.dockOrder
        .map((id) => fleet.runsById[id])
        .filter((r): r is Run => Boolean(r))
    : [];
  const used = fleet?.capacity.used ?? 0;
  const max = fleet?.capacity.max ?? 1;

  return (
    <nav className="fleet-dock" aria-label="Fleet dock">
      <button className="dock-head" type="button" onClick={onDeploy}>
        <span>Fleet</span>
        <strong>
          {used} <em>/ {max}</em>
        </strong>
        <small>{connectionState}</small>
      </button>

      <div className="dock-cells">
        {runs.length === 0 ? (
          <div className={`dock-empty ${styles.smallOcta}`}>
            <span className="avatar-cell">π</span>
            <span>No active deployments</span>
          </div>
        ) : (
          runs.map((run) => (
            <Link
              className={`dock-cell ${styles.smallOcta} ${run.status} ${run.id === runId ? "current" : ""}`}
              to={`/runs/${run.id}/cockpit`}
              key={run.id}
            >
              <span className="avatar-cell">π</span>
              <span className="dock-cell-body">
                <span className="dock-cell-title">{run.directive}</span>
                <span className="dock-cell-meta">
                  {run.id} · {run.branch}
                </span>
                <StatusPill status={run.status} />
              </span>
            </Link>
          ))
        )}
      </div>

      <div className="dock-actions">
        <button
          className="dock-button muted"
          type="button"
          title="Gated until all pending runs are green"
        >
          <CheckCheck size={14} />
          Merge all green
        </button>
        <button className="dock-button deploy" type="button" onClick={onDeploy}>
          <Play size={14} fill="currentColor" />
          Deploy <kbd>Ctrl D</kbd>
        </button>
      </div>
    </nav>
  );
}
