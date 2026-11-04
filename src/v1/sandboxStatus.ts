import { posix } from "node:path";
import { DateTime, Either, Schema } from "effect";
import type { FinishReport } from "./FinishReport.js";
import { FinishReportJson } from "./finishReportSchema.js";
import type { EndedWork, SandboxStatus, StatusOptions } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import { SandboxUnavailableError } from "./SandboxUnavailableError.js";
import { REPORTS_DIRECTORY } from "./supervisorDetach.js";
import type { SupervisorStatus } from "./supervisorStatusSchema.js";
import { STATUS_FILE, SupervisorStatusJson } from "./supervisorStatusSchema.js";

// The host's side of `status()`: everything comes from the supervisor's files,
// read through the provider, so it needs no live supervisor.

const DEFAULT_LOG_LINES = 50;

const decodeStatus = Schema.decodeUnknownEither(SupervisorStatusJson);
const decodeReport = Schema.decodeUnknownEither(FinishReportJson);

const dateOf = (iso: string): Date =>
  DateTime.toDateUtc(DateTime.unsafeMake(iso));

/** The supervisor's status file, or `undefined` when there is none. */
export const readSupervisorStatus = async (
  sandbox: ProviderSandbox,
  directory: string,
): Promise<SupervisorStatus | undefined> => {
  const text = await sandbox.readTextFile({
    path: posix.join(directory, STATUS_FILE),
  });
  if (text === null) {
    return undefined;
  }
  const decoded = decodeStatus(text);
  if (Either.isLeft(decoded)) {
    throw new Error("the session supervisor's status file is unreadable", {
      cause: decoded.left,
    });
  }
  return decoded.right;
};

const readReport = async (
  sandbox: ProviderSandbox,
  directory: string,
  detachId: string,
): Promise<FinishReport | undefined> => {
  const text = await sandbox.readTextFile({
    path: posix.join(directory, REPORTS_DIRECTORY, `${detachId}.json`),
  });
  const decoded = text === null ? undefined : decodeReport(text);
  if (decoded === undefined || Either.isLeft(decoded)) {
    return undefined;
  }
  const report = decoded.right;
  // Spelled out, as verifyFinishReport does, so each output is `unknown`.
  return {
    ...report,
    data: {
      ...report.data,
      sessions: Object.fromEntries(
        Object.entries(report.data.sessions).map(([name, session]) => [
          name,
          { ...session, output: session.output },
        ]),
      ),
    },
  };
};

const logTail = async (
  sandbox: ProviderSandbox,
  directory: string,
  lines: number,
): Promise<string[]> => {
  if (lines <= 0) {
    return [];
  }
  const text = await sandbox.readTextFile({
    path: posix.join(directory, "supervisor.log"),
  });
  return (text ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .slice(-lines);
};

const detachedPart = async (
  sandbox: ProviderSandbox,
  directory: string,
  detached: NonNullable<SupervisorStatus["detached"]>,
): Promise<SandboxStatus["detached"]> => {
  const report = await readReport(sandbox, directory, detached.detachId);
  return {
    detachId: detached.detachId,
    detachedAt: dateOf(detached.detachedAt),
    deadline: dateOf(detached.deadline),
    reportsTo: detached.reportsTo,
    delivery: detached.delivery,
    ...(report === undefined ? {} : { finishReport: report }),
  };
};

const endedWork = ({
  name,
  agent,
  exitReason,
  record,
}: SupervisorStatus["ended"][number]): EndedWork => {
  const work: EndedWork = { kind: "session", name, agent, exitReason };
  return record === undefined ? work : { ...work, record };
};

/** `status()` for a sandbox whose supervisor lives in `directory`. */
export const readStatus = async (
  sandbox: ProviderSandbox,
  directory: string,
  options: StatusOptions = {},
): Promise<SandboxStatus> => {
  const { logLines = DEFAULT_LOG_LINES } = options;
  if (!Number.isInteger(logLines) || logLines < 0) {
    throw new RangeError(
      `status: logLines must be a whole number, 0 or more, got ${logLines}`,
    );
  }
  const status = await readSupervisorStatus(sandbox, directory);
  if (status === undefined) {
    throw new SandboxUnavailableError({
      message: `Sandbox ${sandbox.sandboxId} has ended: its session supervisor's files are gone.`,
      sandboxId: sandbox.sandboxId,
    });
  }
  const [detached, logs] = await Promise.all([
    status.detached === undefined
      ? undefined
      : detachedPart(sandbox, directory, status.detached),
    logTail(sandbox, directory, logLines),
  ]);
  return {
    sandboxId: sandbox.sandboxId,
    killTime: sandbox.killTime,
    running: status.running.map(({ name, agent }) => ({
      kind: "session",
      name,
      agent,
    })),
    ended: status.ended.map((work) => endedWork(work)),
    ...(detached === undefined ? {} : { detached }),
    logs,
  };
};
