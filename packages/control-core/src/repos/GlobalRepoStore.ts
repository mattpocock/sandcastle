import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { RegisteredRepo } from "@sandcastle/protocol";

interface RepoRegistryFile {
  readonly version: 1;
  readonly repos: RegisteredRepo[];
}

export class GlobalRepoStore {
  readonly path: string;

  constructor(homeDir = resolveSandcastleHome()) {
    this.path = join(homeDir, "repos.json");
  }

  listRepos(): RegisteredRepo[] {
    return this.read().repos;
  }

  registerRepo(root: string): RegisteredRepo {
    const resolvedRoot = resolve(root);
    const data = this.read();
    const existing = data.repos.find((repo) =>
      rootsEqual(repo.root, resolvedRoot),
    );
    const now = new Date().toISOString();
    if (existing) {
      const updated = { ...existing, lastOpenedAt: now };
      this.write({
        version: 1,
        repos: data.repos.map((repo) =>
          repo.id === existing.id ? updated : repo,
        ),
      });
      return updated;
    }

    const repo: RegisteredRepo = {
      id: nanoid(),
      root: resolvedRoot,
      addedAt: now,
      lastOpenedAt: now,
    };
    this.write({ version: 1, repos: [...data.repos, repo] });
    return repo;
  }

  removeRepo(id: string): boolean {
    const data = this.read();
    const repos = data.repos.filter((repo) => repo.id !== id);
    if (repos.length === data.repos.length) return false;
    this.write({ version: 1, repos });
    return true;
  }

  touchRepo(id: string): RegisteredRepo | undefined {
    const data = this.read();
    const repo = data.repos.find((entry) => entry.id === id);
    if (!repo) return undefined;
    const updated = { ...repo, lastOpenedAt: new Date().toISOString() };
    this.write({
      version: 1,
      repos: data.repos.map((entry) => (entry.id === id ? updated : entry)),
    });
    return updated;
  }

  private read(): RepoRegistryFile {
    if (!existsSync(this.path)) return { version: 1, repos: [] };
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!isRepoRegistryFile(parsed)) {
      throw new Error(`Invalid Sandcastle repo registry: ${this.path}`);
    }
    return parsed;
  }

  private write(data: RepoRegistryFile): void {
    atomicWriteJson(this.path, data);
  }
}

export const resolveSandcastleHome = (): string => {
  const home =
    process.env.SANDCASTLE_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("Unable to resolve home directory");
  return join(home, ".sandcastle");
};

const isRepoRegistryFile = (value: unknown): value is RepoRegistryFile => {
  if (!value || typeof value !== "object") return false;
  const record = value as { version?: unknown; repos?: unknown };
  return (
    record.version === 1 &&
    Array.isArray(record.repos) &&
    record.repos.every(isRegisteredRepo)
  );
};

const isRegisteredRepo = (value: unknown): value is RegisteredRepo => {
  if (!value || typeof value !== "object") return false;
  const repo = value as Record<string, unknown>;
  return (
    typeof repo.id === "string" &&
    typeof repo.root === "string" &&
    typeof repo.addedAt === "string" &&
    typeof repo.lastOpenedAt === "string"
  );
};

const rootsEqual = (left: string, right: string): boolean => {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
};

export const atomicWriteJson = (path: string, data: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.${process.pid}.${Date.now()}.${nanoid()}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
};
