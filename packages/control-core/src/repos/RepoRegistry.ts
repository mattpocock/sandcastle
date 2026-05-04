import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoInfo {
  readonly root: string;
  readonly branch: string;
  readonly repoName: string;
}

export class RepoRegistry {
  readonly root: string;

  constructor(repoPath: string) {
    this.root = resolve(repoPath);
    if (!existsSync(this.root)) {
      throw new Error(`Repo path does not exist: ${this.root}`);
    }
    if (!existsSync(resolve(this.root, ".sandcastle"))) {
      throw new Error(`Repo is not initialized for Sandcastle: ${this.root}`);
    }
  }

  async getRepo(): Promise<RepoInfo> {
    return {
      root: this.root,
      branch: await this.getBranch(),
      repoName: basename(this.root),
    };
  }

  async getBranch(): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: this.root,
      },
    );
    return stdout.trim();
  }
}
