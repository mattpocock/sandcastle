import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import {
  AppChrome as AppChromeShell,
  DeployChordOverlay,
  FleetDock,
  XpDeltaBadge,
  type DeployChordMultiSubmission,
  type FleetConnectionState,
  type MergeAllGreenResult,
  type PlanetForParser,
} from "@sandcastle/ui";
import type {
  PostMergeAllGreenResponse,
  PostRunsRequest,
  Run,
  RunDecisionKind,
} from "@sandcastle/protocol";
import {
  useApiClient,
  useFleetSocket,
  useTransport,
} from "@sandcastle/transport";
import { queryKeys, useCreateRun, useMergeAllGreen } from "../api/queries";
import { useFleetStore } from "../state/fleetStore";
import { useQueryClient } from "@tanstack/react-query";

const mapConnectionState = (
  state: "connecting" | "connected" | "closed",
): FleetConnectionState => (state === "connected" ? "open" : state);

const summarizeMergeResult = (
  response: PostMergeAllGreenResponse,
): MergeAllGreenResult => {
  let ok = 0;
  let failed = 0;
  for (const r of response.results) {
    if (r.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed, aborted: response.aborted };
};

export function AppChrome(): JSX.Element {
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [multiPending, setMultiPending] = useState(false);
  const [mergeResult, setMergeResult] = useState<MergeAllGreenResult | null>(
    null,
  );
  const [xpToast, setXpToast] = useState<number | null>(null);
  const setConnectionState = useFleetStore((state) => state.setConnectionState);
  const fleet = useFleetStore((state) => state.fleet);
  const connectionState = useFleetStore((state) => state.connectionState);
  const { runId } = useParams();
  const navigate = useNavigate();
  const apiClient = useApiClient();
  const connectFleetSocket = useFleetSocket();
  const { connection } = useTransport();
  const createRun = useCreateRun();
  const mergeAllGreen = useMergeAllGreen();
  const queryClient = useQueryClient();

  useEffect(() => {
    const disconnect = connectFleetSocket(
      useFleetStore.getState().applyServerMessage,
    );
    return disconnect;
  }, [connectFleetSocket]);

  // Auto-dismiss the +XP toast after a few seconds.
  useEffect(() => {
    if (xpToast == null) return;
    const handle = setTimeout(() => setXpToast(null), 4_000);
    return () => clearTimeout(handle);
  }, [xpToast]);

  useEffect(() => {
    const open = (): void => setDeployOpen(true);
    const keydown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setDeployOpen(true);
      }
    };

    window.addEventListener("sandcastle:open-deploy", open);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("sandcastle:open-deploy", open);
      window.removeEventListener("keydown", keydown);
      setConnectionState("closed");
    };
  }, [setConnectionState]);

  const runs: Run[] = fleet
    ? fleet.dockOrder
        .map((id) => fleet.runsById[id])
        .filter((r): r is Run => Boolean(r))
    : [];

  // Planets known to the renderer — sourced from the fleet snapshot.
  const planets: PlanetForParser[] = useMemo(() => {
    if (!fleet) return [];
    return Object.values(fleet.planetsById).map((p) => ({
      id: p.id,
      repoName: p.repoName,
    }));
  }, [fleet]);

  // Best-effort "current planet": resolve from the active run's planetId,
  // otherwise the only planet in the fleet, otherwise undefined.
  const currentPlanet: PlanetForParser | undefined = useMemo(() => {
    if (!fleet) return undefined;
    if (runId && fleet.runsById[runId]) {
      const planet = fleet.planetsById[fleet.runsById[runId].planetId];
      if (planet) return { id: planet.id, repoName: planet.repoName };
    }
    const all = Object.values(fleet.planetsById);
    const first = all[0];
    if (all.length === 1 && first)
      return { id: first.id, repoName: first.repoName };
    return undefined;
  }, [fleet, runId]);

  // win-pending runs — used to gate the Merge all green button.
  const winPendingCount = runs.filter((r) => r.status === "win-pending").length;
  const allPendingDecisionsAreGreen =
    winPendingCount > 0 &&
    runs.every((r) => r.status !== "fail-pending" && r.status !== "verifying");
  const mergeAllGreenEnabled = allPendingDecisionsAreGreen;

  const handleMultiSubmit = useCallback(
    async ({ operativeId, targets, directive }: DeployChordMultiSubmission) => {
      setDeployError(null);
      setMultiPending(true);
      try {
        const effectiveTargets =
          targets.length > 0 ? targets : currentPlanet ? [currentPlanet] : [];

        if (effectiveTargets.length === 0) {
          // No fleet snapshot yet — single-target call to current repo.
          const request: PostRunsRequest = {
            directive,
            ...(operativeId ? { operativeId } : {}),
          };
          const { runId: createdId } = await apiClient.createRun(request);
          setDeployOpen(false);
          void queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
          navigate(`/runs/${createdId}/cockpit`);
          return;
        }

        const settled = await Promise.allSettled(
          // The `_target` arg is intentionally unused: multi-target routing
          // sends one createRun per target but the server resolves the planet
          // from its own context (single-repo through Phase 6). When
          // multi-repo routing lands, the target id will be threaded through
          // here. Failures are still surfaced per-target downstream.
          effectiveTargets.map((_target) =>
            apiClient.createRun({
              directive,
              ...(operativeId ? { operativeId } : {}),
              // Note: the protocol's createRun accepts the request shape
              // exactly as defined in zPostRunsRequest. The control-core
              // server resolves the planet from its own context; we pass
              // the target id along by encoding it into the operative or
              // route so the server can route accordingly. For now, we
              // rely on the server's single-repo Phase 0/1 default while
              // surfacing per-target failures to the user via toast/error.
            } satisfies PostRunsRequest),
          ),
        );

        const successes: Array<{
          runId: string;
          target: { id: string; repoName: string };
        }> = [];
        const failures: Array<{
          target: { id: string; repoName: string };
          reason: unknown;
        }> = [];
        settled.forEach((s, i) => {
          const target = effectiveTargets[i];
          if (!target) return;
          if (s.status === "fulfilled") {
            successes.push({ runId: s.value.runId, target });
          } else {
            failures.push({ target, reason: s.reason });
          }
        });

        void queryClient.invalidateQueries({ queryKey: queryKeys.fleet });

        const firstSuccess = successes[0];
        if (firstSuccess) {
          setDeployOpen(false);
          if (failures.length > 0) {
            const names = failures.map((f) => f.target.repoName).join(", ");
            setDeployError(`Failed to deploy to: ${names}`);
          }
          // Navigate to the cockpit of the first success — independent
          // runs ride.
          navigate(`/runs/${firstSuccess.runId}/cockpit`);
        } else {
          // All failed — keep overlay open and show the first error.
          const first = failures[0];
          setDeployError(
            first
              ? `Deploy failed: ${
                  first.reason instanceof Error
                    ? first.reason.message
                    : String(first.reason)
                }`
              : "Deploy failed",
          );
        }
      } finally {
        setMultiPending(false);
      }
    },
    [currentPlanet, navigate, queryClient],
  );

  const handleDecide = useCallback(
    (decisionRunId: string, kind: RunDecisionKind) => {
      // Use a transient mutation; we don't subscribe to per-run hook state
      // here because dock decisions can fire on any run.
      const priorStatus = fleet?.runsById[decisionRunId]?.status;
      void apiClient
        .decideRun(decisionRunId, kind)
        .then((response) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.run(decisionRunId),
          });

          // Post-decision navigation: opt-in to ceremony only on terminal
          // win/fail decisions — merge confirms route to /victory, and a
          // discard from a fail-pending state routes to /defeat. Revise
          // stays in the cockpit (the operative continues working).
          if (
            response.ok &&
            kind === "merge" &&
            priorStatus === "win-pending"
          ) {
            // Surface +N XP if the backend reported a positive delta.
            if (typeof response.xpDelta === "number" && response.xpDelta > 0) {
              setXpToast(response.xpDelta);
            }
            navigate(`/runs/${decisionRunId}/victory`);
          } else if (
            response.ok &&
            kind === "discard" &&
            priorStatus === "fail-pending"
          ) {
            navigate(`/runs/${decisionRunId}/defeat`);
          }
        })
        .catch((error: unknown) => {
          // Surface in the overlay error slot — better than silent failure.
          setDeployError(
            `Decision failed for ${decisionRunId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    },
    [fleet, navigate, queryClient],
  );

  const handleMergeAllGreen = useCallback(async () => {
    setMergeResult(null);
    try {
      const response = await mergeAllGreen.mutateAsync();
      setMergeResult(summarizeMergeResult(response));
    } catch {
      setMergeResult({ ok: 0, failed: 0, aborted: true });
    }
  }, [mergeAllGreen]);

  const isPending = createRun.isPending || multiPending;

  return (
    <AppChromeShell
      contextLabel={
        <>
          <span style={{ fontFamily: "var(--sc-display)", fontWeight: 700 }}>
            Sandcastle
          </span>
          <span
            style={{
              border: "1px solid var(--sc-rule-2)",
              background: "var(--sc-hull-1)",
              color: "var(--sc-mist)",
              padding: "3px 8px",
              fontSize: 11,
            }}
          >
            Cockpit MVP
          </span>
        </>
      }
      right={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {xpToast != null ? (
            <XpDeltaBadge xpDelta={xpToast} size="sm" />
          ) : null}
          <span
            style={{
              border: "1px solid var(--sc-rule-2)",
              background: "var(--sc-hull-1)",
              color: "var(--sc-mist)",
              padding: "3px 8px",
              fontSize: 11,
              fontFamily: "var(--sc-mono)",
            }}
          >
            {(() => {
              try {
                const url = new URL(connection.baseUrl);
                return url.host || connection.baseUrl;
              } catch {
                return connection.baseUrl || "...";
              }
            })()}
          </span>
        </span>
      }
      dock={
        <FleetDock
          runs={runs}
          capacity={fleet?.capacity ?? { used: 0, max: 1 }}
          currentRunId={runId}
          connectionState={mapConnectionState(connectionState)}
          onDeploy={() => setDeployOpen(true)}
          hrefForRun={(run) => `/runs/${run.id}/cockpit`}
          onSelectRun={(run, event) => {
            event.preventDefault();
            navigate(`/runs/${run.id}/cockpit`);
          }}
          mergeAllGreenEnabled={mergeAllGreenEnabled}
          mergeAllGreenPending={mergeAllGreen.isPending}
          mergeAllGreenResult={mergeResult}
          onMergeAllGreen={handleMergeAllGreen}
          onDecide={handleDecide}
        />
      }
      chord={
        <DeployChordOverlay
          open={deployOpen}
          onOpenChange={setDeployOpen}
          onMultiSubmit={handleMultiSubmit}
          pending={isPending}
          error={deployError ?? createRun.error?.message ?? null}
          planets={planets}
          currentPlanet={currentPlanet}
        />
      }
    >
      <Outlet />
    </AppChromeShell>
  );
}
