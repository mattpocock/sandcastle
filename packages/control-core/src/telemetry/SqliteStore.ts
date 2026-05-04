import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ActivityEvent,
  RepoTelemetry,
  Run,
  RunEvent,
  XpLedgerEntry,
} from "@sandcastle/protocol";

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
  getDomainCache<T>(
    repoRoot: string,
    domain: string,
  ): DomainCache<T> | undefined;
  setDomainCache(repoRoot: string, domain: string, value: unknown): void;
  insertXpEntry(entry: XpLedgerEntry): boolean;
  listXpEntries(filter?: XpEntryFilter): XpLedgerEntry[];
  markXpReverted(repoRoot: string, patchHash: string, revertedAt: string): void;
  appendActivity(repoRoot: string, event: ActivityEvent): void;
  listActivity(repoRoot: string, limit: number): ActivityEvent[];
  close(): void;
}

export interface DomainCache<T> {
  readonly indexedAt: string;
  readonly value: T;
}

export interface XpEntryFilter {
  readonly runId?: string;
  readonly operativeId?: string;
  readonly repoRoot?: string;
}

export class SqliteStore {
  private readonly driver: StoreDriver;

  constructor(repoRoot: string) {
    const dbPath = join(repoRoot, ".sandcastle", "state", "sandcastle.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.driver = new BetterSqliteDriver(loadBetterSqlite3(), dbPath);
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

  getDomainCache<T>(
    repoRoot: string,
    domain: string,
  ): DomainCache<T> | undefined {
    return this.driver.getDomainCache<T>(repoRoot, domain);
  }

  setDomainCache(repoRoot: string, domain: string, value: unknown): void {
    this.driver.setDomainCache(repoRoot, domain, value);
  }

  insertXpEntry(entry: XpLedgerEntry): boolean {
    return this.driver.insertXpEntry(entry);
  }

  listXpEntries(filter?: XpEntryFilter): XpLedgerEntry[] {
    return this.driver.listXpEntries(filter);
  }

  markXpReverted(
    repoRoot: string,
    patchHash: string,
    revertedAt: string,
  ): void {
    this.driver.markXpReverted(repoRoot, patchHash, revertedAt);
  }

  appendActivity(repoRoot: string, event: ActivityEvent): void {
    this.driver.appendActivity(repoRoot, event);
  }

  listActivity(repoRoot: string, limit = 50): ActivityEvent[] {
    return this.driver.listActivity(repoRoot, limit);
  }

  close(): void {
    this.driver.close();
  }
}

type BetterSqlite3Constructor = new (path: string) => any;

const loadBetterSqlite3 = (): BetterSqlite3Constructor => {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3") as BetterSqlite3Constructor;
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
CREATE TABLE IF NOT EXISTS telemetry_domain_cache (
  repo_root TEXT NOT NULL,
  domain TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (repo_root, domain)
);
CREATE TABLE IF NOT EXISTS xp_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  operative_id TEXT NOT NULL,
  patch_hash TEXT NOT NULL,
  base_xp INTEGER NOT NULL,
  bonus INTEGER NOT NULL,
  penalty INTEGER NOT NULL,
  net_xp INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  reverted_at TEXT,
  UNIQUE(repo_root, patch_hash)
);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_operative_recorded_at
  ON xp_ledger(operative_id, recorded_at DESC);
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_events_repo_at
  ON activity_events(repo_root, at DESC);
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

  getDomainCache<T>(
    repoRoot: string,
    domain: string,
  ): DomainCache<T> | undefined {
    const row = this.db
      .prepare(
        "SELECT indexed_at, raw_json FROM telemetry_domain_cache WHERE repo_root = ? AND domain = ?",
      )
      .get(repoRoot, domain) as
      | { indexed_at: number; raw_json: string }
      | undefined;
    if (!row) return undefined;
    return {
      indexedAt: new Date(row.indexed_at).toISOString(),
      value: JSON.parse(row.raw_json) as T,
    };
  }

  setDomainCache(repoRoot: string, domain: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO telemetry_domain_cache (repo_root, domain, indexed_at, raw_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_root, domain) DO UPDATE SET
           indexed_at = excluded.indexed_at,
           raw_json = excluded.raw_json`,
      )
      .run(repoRoot, domain, Date.now(), JSON.stringify(value));
  }

  insertXpEntry(entry: XpLedgerEntry): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO xp_ledger
         (run_id, repo_root, operative_id, patch_hash, base_xp, bonus, penalty, net_xp, recorded_at, reverted_at)
         VALUES (@runId, @repoRoot, @operativeId, @patchHash, @baseXp, @bonus, @penalty, @netXp, @recordedAt, @revertedAt)`,
      )
      .run(entry);
    return result.changes === 1;
  }

  listXpEntries(filter?: XpEntryFilter): XpLedgerEntry[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter?.runId) {
      clauses.push("run_id = @runId");
      params.runId = filter.runId;
    }
    if (filter?.operativeId) {
      clauses.push("operative_id = @operativeId");
      params.operativeId = filter.operativeId;
    }
    if (filter?.repoRoot) {
      clauses.push("repo_root = @repoRoot");
      params.repoRoot = filter.repoRoot;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT run_id, repo_root, operative_id, patch_hash, base_xp, bonus, penalty, net_xp, recorded_at, reverted_at
         FROM xp_ledger ${where} ORDER BY recorded_at DESC, id DESC`,
      )
      .all(params) as Array<{
      run_id: string;
      repo_root: string;
      operative_id: string;
      patch_hash: string;
      base_xp: number;
      bonus: number;
      penalty: number;
      net_xp: number;
      recorded_at: string;
      reverted_at: string | null;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      repoRoot: row.repo_root,
      operativeId: row.operative_id,
      patchHash: row.patch_hash,
      baseXp: row.base_xp,
      bonus: row.bonus,
      penalty: row.penalty,
      netXp: row.net_xp,
      recordedAt: row.recorded_at,
      revertedAt: row.reverted_at,
    }));
  }

  markXpReverted(
    repoRoot: string,
    patchHash: string,
    revertedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE xp_ledger
         SET reverted_at = COALESCE(reverted_at, ?), net_xp = 0
         WHERE repo_root = ? AND patch_hash = ? AND reverted_at IS NULL`,
      )
      .run(revertedAt, repoRoot, patchHash);
  }

  appendActivity(repoRoot: string, event: ActivityEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO activity_events
         (id, repo_root, at, type, run_id, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repoRootScopedActivityId(repoRoot, event.id),
        repoRoot,
        event.at,
        event.type,
        event.runId,
        JSON.stringify(event),
      );
  }

  listActivity(repoRoot: string, limit: number): ActivityEvent[] {
    const rows = this.db
      .prepare(
        "SELECT raw_json FROM activity_events WHERE repo_root = ? ORDER BY at DESC LIMIT ?",
      )
      .all(repoRoot, Math.max(1, Math.min(500, limit))) as Array<{
      raw_json: string;
    }>;
    return rows.map((row) => JSON.parse(row.raw_json) as ActivityEvent);
  }

  close(): void {
    this.db.close();
  }
}

const reviveEvent = (event: RunEvent): RunEvent =>
  ({
    ...event,
    timestamp: new Date(event.timestamp),
  }) as RunEvent;

const repoRootScopedActivityId = (repoRoot: string, id: string): string =>
  `${repoRoot}\0${id}`;
