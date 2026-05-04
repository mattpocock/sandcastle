import type { JSX } from "react";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import type { Run } from "@sandcastle/protocol";
import { useFleet, useRepo } from "../api/queries";
import { useFleetStore } from "../state/fleetStore";
import { StatusPill } from "../primitives/StatusPill";

export function IndexRoute(): JSX.Element {
  const { data: repo } = useRepo();
  const { data: queriedFleet } = useFleet();
  const liveFleet = useFleetStore((state) => state.fleet);
  const fleet = liveFleet ?? queriedFleet;
  const runs: Run[] = fleet
    ? fleet.dockOrder
        .map((id) => fleet.runsById[id])
        .filter((r): r is Run => Boolean(r))
    : [];

  return (
    <section className="landing-grid">
      <div className="panel hero-panel">
        <div className="eyebrow">phase 0 · cockpit</div>
        <h1>Sandcastle control cockpit</h1>
        <p>
          Local Electron supervisor connected to control-core. Deploy one real
          run, stream tool/text events, and abort from the cockpit.
        </p>
        <button
          className="primary-action"
          type="button"
          onClick={() =>
            window.dispatchEvent(new Event("sandcastle:open-deploy"))
          }
        >
          <Play size={16} fill="currentColor" />
          Deploy
        </button>
      </div>

      <aside className="panel repo-panel">
        <div className="eyebrow">repo</div>
        <h2>{repo?.branch ?? "loading branch"}</h2>
        <p>{repo?.root ?? "waiting for control-core"}</p>
      </aside>

      <div className="panel runs-panel">
        <div className="panel-head">
          <div>
            <div className="eyebrow">runs</div>
            <h2>Recent deployments</h2>
          </div>
          <span className="mono-chip">{runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <p className="muted-copy">
            No runs have been deployed from this UI session yet.
          </p>
        ) : (
          <div className="run-list">
            {runs.map((run) => (
              <Link
                className="run-list-row"
                to={`/runs/${run.id}/cockpit`}
                key={run.id}
              >
                <span>
                  <strong>{run.directive}</strong>
                  <small>{run.id}</small>
                </span>
                <StatusPill status={run.status} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
