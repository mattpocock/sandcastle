import type { JSX } from "react";
import {
  CheckCircle2,
  CircleDot,
  FileText,
  Terminal,
  XCircle,
} from "lucide-react";
import type { RunEvent } from "@sandcastle/protocol";

export function CockpitTimeline({
  events,
}: {
  readonly events: readonly RunEvent[];
}): JSX.Element {
  if (events.length === 0) {
    return (
      <div className="empty-timeline">
        <span className="empty-reticle" />
        <p>Awaiting first stream packet.</p>
      </div>
    );
  }

  return (
    <ol className="timeline-list" aria-label="Run timeline">
      {events.map((event, index) => (
        <li
          className={`timeline-event event-${event.type.replace(".", "-")}`}
          key={`${event.type}-${index}`}
        >
          <span className="timeline-icon">{iconFor(event)}</span>
          <div className="timeline-body">
            <div className="timeline-meta">
              <span>{formatEventTitle(event)}</span>
              <time>{formatTime(event.timestamp)}</time>
            </div>
            {renderPayload(event)}
          </div>
        </li>
      ))}
    </ol>
  );
}

const iconFor = (event: RunEvent): JSX.Element => {
  if (event.type === "tool.started" || event.type === "toolCall")
    return <Terminal size={15} />;
  if (event.type === "tool.finished")
    return event.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />;
  if (event.type === "text") return <FileText size={15} />;
  return <CircleDot size={15} />;
};

const formatTime = (timestamp: Date): string =>
  timestamp.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const formatEventTitle = (event: RunEvent): string => {
  switch (event.type) {
    case "text":
      return "text";
    case "toolCall":
      return `tool call · ${event.name}`;
    case "tool.started":
      return `tool started · ${event.name}`;
    case "tool.finished":
      return `tool finished · ${event.name}`;
    case "run.statusChanged":
      return `status · ${event.from} to ${event.to}`;
    case "run.resolved":
      return `resolved · ${event.result}`;
    case "run.started":
      return "run started";
    case "verification.started":
      return "verification started";
    case "verification.finished":
      return event.allGreen ? "verification green" : "verification failed";
    case "decision.required":
      return `decision · ${event.kind}`;
    case "intervention.used":
      return `intervention · ${event.action}`;
  }
};

const renderPayload = (event: RunEvent): JSX.Element | null => {
  switch (event.type) {
    case "text":
      return <pre className="timeline-text">{event.message}</pre>;
    case "tool.started":
    case "toolCall":
      return (
        <code className="timeline-code">
          {event.formattedArgs || "no args"}
        </code>
      );
    case "tool.finished":
      return event.output ? (
        <pre className="timeline-text">{event.output}</pre>
      ) : null;
    case "run.started":
      return <p>{event.directive}</p>;
    case "verification.started":
      return (
        <p>
          {event.checks.length ? event.checks.join(", ") : "checks pending"}
        </p>
      );
    case "verification.finished":
      return (
        <p>
          {event.failedChecks.length
            ? event.failedChecks.join(", ")
            : "all checks green"}
        </p>
      );
    default:
      return null;
  }
};
