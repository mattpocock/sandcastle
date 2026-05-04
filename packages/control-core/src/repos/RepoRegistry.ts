import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RegisteredRepo } from "@sandcastle/protocol";
import { GlobalRepoStore } from "./GlobalRepoStore.js";

const execFileAsync = promisify(execFile);

export interface RepoInfo {
  readonly id: string;
  readonly root: string;
  readonly branch: string;
  readonly repoName: string;
}

export class RepoRegistry {
  private currentRepoId: string;

  constructor(
    repoPath: string,
    private readonly store = new GlobalRepoStore(),
  ) {
    const registered = this.registerRepo(repoPath);
    this.currentRepoId = registered.id;
  }

  get root(): string {
    return this.getCurrentRepo().root;
  }

  registerRepo(repoPath: string): RegisteredRepo {
    const root = resolve(repoPath);
    validateRepoRoot(root);
    return this.store.registerRepo(root);
  }

  removeRepo(id: string): boolean {
    const removed = this.store.removeRepo(id);
    if (removed && id === this.currentRepoId) {
      const next = this.listRepos()[0];
      if (next) this.currentRepoId = next.id;
    }
    return removed;
  }

  listRepos(): RegisteredRepo[] {
    return [...this.store.listRepos()].sort((a, b) => {
      const opened = Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt);
      if (opened !== 0) return opened;
      return Date.parse(b.addedAt) - Date.parse(a.addedAt);
    });
  }

  getCurrentRepo(): RegisteredRepo {
    const repo = this.store
      .listRepos()
      .find((entry) => entry.id === this.currentRepoId);
    if (!repo) throw new Error("No current Sandcastle repo is registered");
    return repo;
  }

  setCurrentRepo(id: string): RegisteredRepo {
    const repo = this.store.touchRepo(id);
    if (!repo) throw new Error(`Unknown Sandcastle repo: ${id}`);
    validateRepoRoot(repo.root);
    this.currentRepoId = repo.id;
    return repo;
  }

  getRepoById(id: string): RegisteredRepo | undefined {
    return this.store.listRepos().find((repo) => repo.id === id);
  }

  async getRepo(): Promise<RepoInfo> {
    const repo = this.getCurrentRepo();
    return {
      id: repo.id,
      root: repo.root,
      branch: await this.getBranch(),
      repoName: basename(repo.root),
    };
  }

  async getBranch(): Promise<string> {
    const repo = this.getCurrentRepo();
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: repo.root,
      },
    );
    return stdout.trim();
  }
}

const validateRepoRoot = (root: string): void => {
  if (!existsSync(root)) {
    throw new Error(`Repo path does not exist: ${root}`);
  }
  if (!existsSync(resolve(root, ".sandcastle"))) {
    throw new Error(`Repo is not initialized for Sandcastle: ${root}`);
  }
};
