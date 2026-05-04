import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RegisteredRepo, RepoTelemetry } from "@sandcastle/protocol";
import type { SqliteStore } from "./SqliteStore.js";

const execFileAsync = promisify(execFile);
const TTL_MS = 60_000;

export class TelemetryIndexer {
  constructor(private readonly store: SqliteStore) {}

  async getTelemetry(
    repo: Pick<RegisteredRepo, "id" | "root">,
    options?: { readonly force?: boolean },
  ): Promise<RepoTelemetry> {
    const cached = this.store.getRepoTelemetry(repo.id);
    if (!options?.force && cached && isFresh(cached)) return cached;

    const telemetry: RepoTelemetry = {
      coveragePct: null,
      ciGreenRate30d: null,
      openIssues: null,
      churnScore: null,
      ageDays: await getAgeDays(repo.root),
      testCount: countTestFiles(repo.root),
      branch: await git(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      lastCommitAt: await git(repo.root, [
        "show",
        "-s",
        "--format=%cI",
        "HEAD",
      ]),
      lastIndexedAt: new Date().toISOString(),
    };
    this.store.upsertRepoTelemetry(repo.id, telemetry);
    return telemetry;
  }
}

const isFresh = (telemetry: RepoTelemetry): boolean =>
  telemetry.lastIndexedAt !== null &&
  Date.now() - Date.parse(telemetry.lastIndexedAt) < TTL_MS;

const getAgeDays = async (repoRoot: string): Promise<number | null> => {
  const firstCommit = await git(repoRoot, [
    "rev-list",
    "--max-parents=0",
    "HEAD",
  ]);
  if (!firstCommit) return null;
  const firstCommitAt = await git(repoRoot, [
    "show",
    "-s",
    "--format=%cI",
    firstCommit,
  ]);
  if (!firstCommitAt) return null;
  const ageMs = Date.now() - Date.parse(firstCommitAt);
  if (!Number.isFinite(ageMs)) return null;
  return Math.max(0, Math.floor(ageMs / 86_400_000));
};

const git = async (
  cwd: string,
  args: readonly string[],
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
};

const countTestFiles = (root: string): number => {
  let count = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name)) count += 1;
    }
  };
  visit(root);
  return count;
};
