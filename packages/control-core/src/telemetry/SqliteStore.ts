import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RepoTelemetry, Run, RunEvent } from "@sandcastle/protocol";

export interface StoredRunEvent {
  readonly seq: number;
  readonly event: RunEvent;
}

interface StoreDriver {
  upsertRun(run: Run): void;
  appendEvent(runId: string, event: RunEvent): number;
  getRun(id: string): Run | undefined;
  listRuns(): Run[];
  listEvents(runId: string): StoredRunEvent[];
  getRepoTelemetry(repoId: string): RepoTelemetry | undefined;
  upsertRepoTelemetry(repoId: string, telemetry: RepoTelemetry): void;
  clearRepoTelemetry(repoId: string): void;
  close(): void;
}

export class SqliteStore {
  private readonly driver: StoreDriver;

  constructor(repoRoot: string) {
    const dbPath = join(repoRoot, ".sandcastle", "state", "sandcastle.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadBetterSqlite3();
    this.driver = Database
      ? new BetterSqliteDriver(Database, dbPath)
      : new JsonFallbackDriver(`${dbPath}.json`);
  }

  upsertRun(run: Run): void {
    this.driver.upsertRun(run);
  }

  appendEvent(runId: string, event: RunEvent): number {
    return this.driver.appendEvent(runId, event);
  }

  getRun(id: string): Run | undefined {
    return this.driver.getRun(id);
  }

  listRuns(): Run[] {
    return this.driver.listRuns();
  }

  listEvents(runId: string): StoredRunEvent[] {
    return this.driver.listEvents(runId);
  }

  getRepoTelemetry(repoId: string): RepoTelemetry | undefined {
    return this.driver.getRepoTelemetry(repoId);
  }

  upsertRepoTelemetry(repoId: string, telemetry: RepoTelemetry): void {
    this.driver.upsertRepoTelemetry(repoId, telemetry);
  }

  clearRepoTelemetry(repoId: string): void {
    this.driver.clearRepoTelemetry(repoId);
  }

  close(): void {
    this.driver.close();
  }
}

type BetterSqlite3Constructor = new (path: string) => any;

const loadBetterSqlite3 = (): BetterSqlite3Constructor | undefined => {
  try {
    const require = createRequire(import.meta.url);
    return require("better-sqlite3") as BetterSqlite3Constructor;
  } catch {
    return undefined;
  }
};

class BetterSqliteDriver implements StoreDriver {
  private readonly db: any;
  private readonly seqByRun = new Map<string, number>();

  constructor(Database: BetterSqlite3Constructor, dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.loadSeqs();
  }

  private migrate(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  directive TEXT NOT NULL,
  branch TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  result TEXT,
  raw_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_id_seq ON run_events(run_id, seq);
CREATE TABLE IF NOT EXISTS repo_telemetry (
  repo_id TEXT PRIMARY KEY,
  indexed_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);
`);
  }

  private loadSeqs(): void {
    const rows = this.db
      .prepare("SELECT run_id, MAX(seq) AS seq FROM run_events GROUP BY run_id")
      .all() as Array<{
      run_id: string;
      seq: number | null;
    }>;
    for (const row of rows) this.seqByRun.set(row.run_id, row.seq ?? 0);
  }

  upsertRun(run: Run): void {
    const startedAt = Date.parse(run.startedAt);
    const endedAt = run.endedAt ? Date.parse(run.endedAt) : null;
    const result = ["victory", "defeat", "aborted"].includes(run.status)
      ? run.status
      : null;
    this.db
      .prepare(
        `INSERT INTO runs (id, directive, branch, worktree_path, status, started_at, ended_at, result, raw_json)
         VALUES (@id, @directive, @branch, @worktreePath, @status, @startedAt, @endedAt, @result, @rawJson)
         ON CONFLICT(id) DO UPDATE SET
           directive = excluded.directive,
           branch = excluded.branch,
           worktree_path = excluded.worktree_path,
           status = excluded.status,
           ended_at = excluded.ended_at,
           result = excluded.result,
           raw_json = excluded.raw_json`,
      )
      .run({
        id: run.id,
        directive: run.directive,
        branch: run.branch,
        worktreePath: run.worktreePath ?? null,
        status: run.status,
        startedAt,
        endedAt,
        result,
        rawJson: JSON.stringify(run),
      });
  }

  appendEvent(runId: string, event: RunEvent): number {
    const seq = (this.seqByRun.get(runId) ?? 0) + 1;
    this.seqByRun.set(runId, seq);
    this.db
      .prepare(
        "INSERT INTO run_events (run_id, seq, at, kind, raw_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        seq,
        event.timestamp.getTime(),
        event.type,
        JSON.stringify(event),
      );
    return seq;
  }

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare("SELECT raw_json FROM runs WHERE id = ?")
      .get(id) as { raw_json: string } | undefined;
    return row ? (JSON.parse(row.raw_json) as Run) : undefined;
  }

  listRuns(): Run[] {
    const rows = this.db
      .prepare("SELECT raw_json FROM runs ORDER BY started_at ASC")
      .all() as Array<{ raw_json: string }>;
    return rows.map((row) => JSON.parse(row.raw_json) as Run);
  }

  listEvents(runId: string): StoredRunEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, raw_json FROM run_events WHERE run_id = ? ORDER BY seq ASC",
      )
      .all(runId) as Array<{
      seq: number;
      raw_json: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      event: reviveEvent(JSON.parse(row.raw_json) as RunEvent),
    }));
  }

  getRepoTelemetry(repoId: string): RepoTelemetry | undefined {
    const row = this.db
      .prepare("SELECT raw_json FROM repo_telemetry WHERE repo_id = ?")
      .get(repoId) as { raw_json: string } | undefined;
    return row ? (JSON.parse(row.raw_json) as RepoTelemetry) : undefined;
  }

  upsertRepoTelemetry(repoId: string, telemetry: RepoTelemetry): void {
    this.db
      .prepare(
        `INSERT INTO repo_telemetry (repo_id, indexed_at, raw_json)
         VALUES (?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           indexed_at = excluded.indexed_at,
           raw_json = excluded.raw_json`,
      )
      .run(
        repoId,
        telemetry.lastIndexedAt ? Date.parse(telemetry.lastIndexedAt) : 0,
        JSON.stringify(telemetry),
      );
  }

  clearRepoTelemetry(repoId: string): void {
    this.db.prepare("DELETE FROM repo_telemetry WHERE repo_id = ?").run(repoId);
  }

  close(): void {
    this.db.close();
  }
}

interface JsonData {
  readonly runs: Record<string, Run>;
  readonly events: Record<string, StoredRunEvent[]>;
  readonly repoTelemetry?: Record<string, RepoTelemetry>;
}

class JsonFallbackDriver implements StoreDriver {
  private data: JsonData;

  constructor(private readonly path: string) {
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as JsonData)
      : { runs: {}, events: {} };
  }

  upsertRun(run: Run): void {
    this.data.runs[run.id] = run;
    this.flush();
  }

  appendEvent(runId: string, event: RunEvent): number {
    const events = this.data.events[runId] ?? [];
    const seq = (events.at(-1)?.seq ?? 0) + 1;
    this.data.events[runId] = [...events, { seq, event }];
    this.flush();
    return seq;
  }

  getRun(id: string): Run | undefined {
    return this.data.runs[id];
  }

  listRuns(): Run[] {
    return Object.values(this.data.runs);
  }

  listEvents(runId: string): StoredRunEvent[] {
    return (this.data.events[runId] ?? []).map((entry) => ({
      ...entry,
      event: reviveEvent(entry.event),
    }));
  }

  getRepoTelemetry(repoId: string): RepoTelemetry | undefined {
    return this.data.repoTelemetry?.[repoId];
  }

  upsertRepoTelemetry(repoId: string, telemetry: RepoTelemetry): void {
    this.data = {
      ...this.data,
      repoTelemetry: {
        ...(this.data.repoTelemetry ?? {}),
        [repoId]: telemetry,
      },
    };
    this.flush();
  }

  clearRepoTelemetry(repoId: string): void {
    const { [repoId]: _removed, ...rest } = this.data.repoTelemetry ?? {};
    this.data = { ...this.data, repoTelemetry: rest };
    this.flush();
  }

  close(): void {}

  private flush(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

const reviveEvent = (event: RunEvent): RunEvent =>
  ({
    ...event,
    timestamp: new Date(event.timestamp),
  }) as RunEvent;
