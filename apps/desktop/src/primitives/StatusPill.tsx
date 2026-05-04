import type { JSX } from "react";
import type { RunStatus } from "@sandcastle/protocol";

const labels: Record<RunStatus, string> = {
  queued: "queued",
  starting: "starting",
  casting: "casting",
  striking: "striking",
  verifying: "verifying",
  "win-pending": "win pending",
  "fail-pending": "fail pending",
  victory: "victory",
  defeat: "defeat",
  aborted: "aborted",
};

export function StatusPill({
  status,
}: {
  readonly status: RunStatus;
}): JSX.Element {
  return (
    <span className={`status-pill status-${status}`}>
      <i aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
