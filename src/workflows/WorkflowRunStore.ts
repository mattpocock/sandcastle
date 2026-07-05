import { randomBytes } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { WorkflowRunNotFoundError } from "./errors.js";
import { sanitizeWorkflowName } from "./sanitizeWorkflowName.js";
import type {
  WorkflowAgentJournalEntry,
  WorkflowControlState,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowRunState,
  WorkflowRunStatus,
} from "./types.js";
import { WorkflowEventLog } from "./WorkflowEventLog.js";

export interface WorkflowRunStoreOptions {
  readonly cwd: string;
  readonly runsRoot?: string;
  readonly now?: () => Date;
  readonly random?: () => string;
}

export interface CreateWorkflowRunOptions {
  readonly meta: WorkflowMeta;
  readonly cwd?: string;
  readonly source?: string;
  readonly sourceFile?: string;
  readonly runId?: string;
  readonly status?: WorkflowRunStatus;
  readonly agentCount?: number;
  readonly maxAgents?: number;
  readonly concurrency?: number;
}

export type WorkflowAgentArtifactName =
  | "prompt"
  | "prompt.md"
  | "result"
  | "result.json"
  | "stdout"
  | "stdout.txt"
  | "log"
  | "log.txt"
  | "diff"
  | "diff.patch"
  | "run"
  | "run.json";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;

const formatRunTimestamp = (date: Date): string => {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
};

const safeRandomSegment = (value: string): string => {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return segment === "" ? randomBytes(4).toString("hex") : segment;
};

const safePathSegment = (value: string, fallback: string): string => {
  const segment = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return segment === "" || segment === "." || segment === ".."
    ? fallback
    : segment;
};

const assertSafeRunId = (runId: string): void => {
  if (
    !RUN_ID_PATTERN.test(runId) ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId === "." ||
    runId === ".."
  ) {
    throw new Error(`Invalid workflow run id: ${runId}`);
  }
};

const artifactFileName = (name: WorkflowAgentArtifactName): string => {
  switch (name) {
    case "prompt":
    case "prompt.md":
      return "prompt.md";
    case "result":
    case "result.json":
      return "result.json";
    case "stdout":
    case "stdout.txt":
      return "stdout.txt";
    case "log":
    case "log.txt":
      return "log.txt";
    case "diff":
    case "diff.patch":
      return "diff.patch";
    case "run":
    case "run.json":
      return "run.json";
  }
};

const serializeJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const defaultControlState = (): WorkflowControlState => ({
  stopRequested: false,
  pauseRequested: false,
});

const errorText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.stack ?? error.message;
  return serializeJson(error);
};

export class WorkflowRunStore {
  readonly cwd: string;
  readonly runsRoot: string;
  private readonly now: () => Date;
  private readonly random: () => string;

  constructor(options: WorkflowRunStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.runsRoot =
      options.runsRoot === undefined
        ? join(this.cwd, ".sandcastle", "runs")
        : resolve(this.cwd, options.runsRoot);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? (() => randomBytes(4).toString("hex"));
  }

  generateRunId(workflowName: string): string {
    return [
      formatRunTimestamp(this.now()),
      sanitizeWorkflowName(workflowName),
      safeRandomSegment(this.random()),
    ].join("-");
  }

  async createRun(
    options: CreateWorkflowRunOptions,
  ): Promise<WorkflowRunState> {
    const runId = options.runId ?? this.generateRunId(options.meta.name);
    assertSafeRunId(runId);

    const runDir = this.getRunDir(runId);
    await mkdir(join(runDir, "agents"), { recursive: true });
    await writeFile(join(runDir, "meta.json"), serializeJson(options.meta));
    await writeFile(join(runDir, "events.jsonl"), "", { flag: "a" });
    await writeFile(join(runDir, "journal.jsonl"), "", { flag: "a" });
    await this.writeAtomic(join(runDir, "control.json"), defaultControlState());

    if (options.source !== undefined || options.sourceFile !== undefined) {
      await this.writeWorkflowSource(runId, options.source, options.sourceFile);
    }

    const state: WorkflowRunState = {
      id: runId,
      status: options.status ?? "created",
      meta: options.meta,
      cwd: resolve(options.cwd ?? this.cwd),
      sourceFile: options.sourceFile,
      startedAt: this.now().toISOString(),
      agentCount: options.agentCount ?? 0,
      maxAgents: options.maxAgents ?? 1,
      concurrency: options.concurrency ?? 1,
    };

    await this.writeState(state);
    return state;
  }

  getRunDir(runId: string): string {
    assertSafeRunId(runId);
    return join(this.runsRoot, runId);
  }

  async writeState(state: WorkflowRunState): Promise<void>;
  async writeState(runId: string, state: WorkflowRunState): Promise<void>;
  async writeState(
    runIdOrState: string | WorkflowRunState,
    maybeState?: WorkflowRunState,
  ): Promise<void> {
    const state = typeof runIdOrState === "string" ? maybeState : runIdOrState;
    if (state === undefined) {
      throw new Error("Workflow run state is required.");
    }
    const runId = typeof runIdOrState === "string" ? runIdOrState : state.id;
    await this.assertRunExists(runId);
    await this.writeAtomic(join(this.getRunDir(runId), "state.json"), state);
  }

  async readState(runId: string): Promise<WorkflowRunState> {
    await this.assertRunExists(runId);
    return JSON.parse(
      await readFile(join(this.getRunDir(runId), "state.json"), "utf8"),
    ) as WorkflowRunState;
  }

  async writeControl(
    runId: string,
    control: WorkflowControlState,
  ): Promise<void> {
    await this.assertRunExists(runId);
    await this.writeAtomic(join(this.getRunDir(runId), "control.json"), {
      stopRequested: control.stopRequested,
      pauseRequested: control.pauseRequested,
      ...(control.stopReason === undefined
        ? {}
        : { stopReason: control.stopReason }),
      ...(control.pauseReason === undefined
        ? {}
        : { pauseReason: control.pauseReason }),
      ...(control.updatedAt === undefined
        ? {}
        : { updatedAt: control.updatedAt }),
    } satisfies WorkflowControlState);
  }

  async readControl(runId: string): Promise<WorkflowControlState> {
    await this.assertRunExists(runId);
    return normalizeControlState(
      await this.readOptionalJson(join(this.getRunDir(runId), "control.json")),
    );
  }

  async updateControl(
    runId: string,
    update: (control: WorkflowControlState) => WorkflowControlState,
  ): Promise<WorkflowControlState> {
    const next = update(await this.readControl(runId));
    await this.writeControl(runId, next);
    return next;
  }

  async requestStop(
    runId: string,
    reason?: string,
  ): Promise<WorkflowControlState> {
    await this.writeStoppingStateIfPresent(runId);
    return this.updateControl(runId, (control) => ({
      ...control,
      stopRequested: true,
      ...(reason === undefined
        ? {}
        : {
            stopReason: reason,
          }),
      updatedAt: this.now().toISOString(),
    }));
  }

  async requestPause(
    runId: string,
    reason?: string,
  ): Promise<WorkflowControlState> {
    return this.updateControl(runId, (control) => ({
      ...control,
      pauseRequested: true,
      ...(reason === undefined
        ? {}
        : {
            pauseReason: reason,
          }),
      updatedAt: this.now().toISOString(),
    }));
  }

  async appendEvent(runId: string, event: WorkflowEvent): Promise<void> {
    await this.assertRunExists(runId);
    await new WorkflowEventLog<WorkflowEvent>(
      join(this.getRunDir(runId), "events.jsonl"),
    ).append(event);
  }

  async readEvents(runId: string): Promise<WorkflowEvent[]> {
    await this.assertRunExists(runId);
    return new WorkflowEventLog<WorkflowEvent>(
      join(this.getRunDir(runId), "events.jsonl"),
    ).readAll();
  }

  async appendJournal(
    runId: string,
    entry: WorkflowAgentJournalEntry,
  ): Promise<void> {
    await this.assertRunExists(runId);
    await new WorkflowEventLog<WorkflowAgentJournalEntry>(
      join(this.getRunDir(runId), "journal.jsonl"),
    ).append(entry);
  }

  async readJournal(runId: string): Promise<WorkflowAgentJournalEntry[]> {
    await this.assertRunExists(runId);
    return new WorkflowEventLog<WorkflowAgentJournalEntry>(
      join(this.getRunDir(runId), "journal.jsonl"),
    ).readAll();
  }

  async writeResult(runId: string, result: unknown): Promise<void> {
    await this.assertRunExists(runId);
    await writeFile(
      join(this.getRunDir(runId), "result.json"),
      serializeJson(result),
    );
  }

  async readResult(runId: string): Promise<unknown | undefined> {
    await this.assertRunExists(runId);
    return this.readOptionalJson(join(this.getRunDir(runId), "result.json"));
  }

  async writeError(runId: string, error: unknown): Promise<void> {
    await this.assertRunExists(runId);
    await writeFile(join(this.getRunDir(runId), "error.txt"), errorText(error));
  }

  async readError(runId: string): Promise<string | undefined> {
    await this.assertRunExists(runId);
    try {
      return await readFile(join(this.getRunDir(runId), "error.txt"), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeWorkflowSource(
    runId: string,
    source: string | undefined,
    sourceFile?: string,
  ): Promise<string> {
    await this.assertRunExists(runId);
    const extension = extname(sourceFile ?? "") === ".js" ? ".js" : ".ts";
    const target = join(this.getRunDir(runId), `workflow${extension}`);

    if (source !== undefined) {
      await writeFile(target, source);
    } else if (sourceFile !== undefined) {
      await copyFile(sourceFile, target);
    } else {
      throw new Error("Workflow source or sourceFile is required.");
    }

    return target;
  }

  async writeAgentArtifact(
    runId: string,
    callId: string,
    name: WorkflowAgentArtifactName,
    value: unknown,
  ): Promise<string> {
    await this.assertRunExists(runId);
    const fileName = artifactFileName(name);
    const agentDir = join(
      this.getRunDir(runId),
      "agents",
      safePathSegment(callId, "agent"),
    );
    await mkdir(agentDir, { recursive: true });

    const artifactPath = join(agentDir, fileName);
    const content = fileName.endsWith(".json")
      ? serializeJson(value)
      : `${String(value)}`;
    await writeFile(artifactPath, content);
    return artifactPath;
  }

  async listRuns(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.runsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  private async assertRunExists(runId: string): Promise<void> {
    const runDir = this.getRunDir(runId);
    try {
      await access(runDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new WorkflowRunNotFoundError(runId);
      }
      throw error;
    }
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tempPath = join(
      dir,
      `.${basename(path)}.${process.pid}.${Date.now()}.${safeRandomSegment(
        this.random(),
      )}.tmp`,
    );
    try {
      await writeFile(tempPath, serializeJson(value));
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private async readOptionalJson(path: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeStoppingStateIfPresent(runId: string): Promise<void> {
    const statePath = join(this.getRunDir(runId), "state.json");
    const state = await this.readOptionalJson(statePath);
    if (!isWorkflowRunState(state) || isTerminalRunStatus(state.status)) {
      return;
    }

    await this.writeAtomic(statePath, {
      ...state,
      status: "stopping",
    } satisfies WorkflowRunState);
  }
}

function normalizeControlState(value: unknown): WorkflowControlState {
  if (typeof value !== "object" || value === null) {
    return defaultControlState();
  }

  const record = value as Record<string, unknown>;
  return {
    stopRequested: record.stopRequested === true,
    pauseRequested: record.pauseRequested === true,
    ...(typeof record.stopReason === "string"
      ? { stopReason: record.stopReason }
      : {}),
    ...(typeof record.pauseReason === "string"
      ? { pauseReason: record.pauseReason }
      : {}),
    ...(typeof record.updatedAt === "string"
      ? { updatedAt: record.updatedAt }
      : {}),
  };
}

function isWorkflowRunState(value: unknown): value is WorkflowRunState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly id?: unknown }).id === "string" &&
    typeof (value as { readonly status?: unknown }).status === "string"
  );
}

function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return (
    status === "failed" ||
    status === "paused" ||
    status === "stopped" ||
    status === "succeeded"
  );
}
