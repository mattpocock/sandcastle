import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecOptions, ExecResult, Sandbox } from "@ai-hero/sandcastle/v1";
import { hostPath } from "./finishReportReceiver.js";

// What the bundled task tests stand on: a stub `claude` for the sandbox's
// PATH, a bare repo standing in for GitHub, and a handle whose `exec` calls
// are recorded. POSIX only.

/**
 * A stub `claude` in `dir/bin`. It writes what it was run with to `dir`,
 * prints the first of `lines`, waits for `dir/go` when `waitForGo`, then
 * prints the rest.
 */
export const stubClaude = async (
  dir: string,
  lines: readonly string[],
  options: { readonly waitForGo?: boolean } = {},
) => {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const [first = "", ...rest] = lines;
  await writeFile(path.join(dir, "first.jsonl"), `${first}\n`);
  await writeFile(path.join(dir, "rest.jsonl"), `${rest.join("\n")}\n`);
  const wait =
    options.waitForGo === true
      ? `while [ ! -f "${dir}/go" ]; do sleep 0.05; done`
      : "";
  const script = [
    "#!/bin/sh",
    `env > "${dir}/agent-env.txt"`,
    `pwd -P > "${dir}/agent-cwd.txt"`,
    `printf '%s\\n' "$*" > "${dir}/agent-argv.txt"`,
    `cat > "${dir}/agent-prompt.txt"`,
    `cat "${dir}/first.jsonl"`,
    wait,
    `cat "${dir}/rest.jsonl"`,
  ].join("\n");
  await writeFile(path.join(bin, "claude"), `${script}\n`);
  await chmod(path.join(bin, "claude"), 0o755);
  return {
    env: { PATH: `${bin}:${hostPath()}` },
    read: async (file: string) => readFile(path.join(dir, file), "utf8"),
    go: async () => writeFile(path.join(dir, "go"), ""),
  };
};

/** A bare repo named `widgets.git` with one commit holding a README. */
export const bareRepo = async (dir: string): Promise<string> => {
  const origin = path.join(dir, "widgets.git");
  const seed = path.join(dir, "seed");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { stdio: "ignore" });
  };
  git("init", "--quiet", "--bare", origin);
  git("init", "--quiet", seed);
  await writeFile(path.join(seed, "README.md"), "# Widgets\n");
  const author = ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t"];
  git(...author, "add", ".");
  git(...author, "commit", "--quiet", "-m", "seed");
  git(...author, "push", "--quiet", origin, "HEAD:refs/heads/main");
  git("-C", origin, "symbolic-ref", "HEAD", "refs/heads/main");
  return origin;
};

/** The sandbox with the options of every `exec` it's given recorded in `calls`. */
export const spied = (sandbox: Sandbox, calls: ExecOptions[]): Sandbox => {
  function exec(
    input: string | (ExecOptions & { readonly allowFailure?: false }),
  ): Promise<ExecResult<0>>;
  function exec(
    options: ExecOptions & { readonly allowFailure: true },
  ): Promise<ExecResult>;
  async function exec(input: string | ExecOptions): Promise<ExecResult> {
    calls.push(typeof input === "string" ? { command: input } : input);
    if (typeof input === "string") {
      return sandbox.exec(input);
    }
    return input.allowFailure === true
      ? sandbox.exec({ ...input, allowFailure: true })
      : sandbox.exec({ ...input, allowFailure: false });
  }
  return { ...sandbox, exec };
};

/**
 * A pull request on the bare repo at `origin`: branch `branch` adds `file`
 * on top of `main`, and `refs/pull/<number>/head` points at it, as on GitHub.
 */
export const pullRequest = async (
  dir: string,
  origin: string,
  pr: {
    readonly number: number;
    readonly branch: string;
    readonly file: string;
  },
): Promise<void> => {
  const work = path.join(dir, `pr-${pr.number}`);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { stdio: "ignore" });
  };
  git("clone", "--quiet", origin, work);
  await writeFile(path.join(work, pr.file), `${pr.branch}\n`);
  const author = ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t"];
  git(...author, "add", ".");
  git(...author, "commit", "--quiet", "-m", `Add ${pr.file}`);
  git(...author, "push", "--quiet", "origin", `HEAD:refs/heads/${pr.branch}`);
  git(
    ...author,
    "push",
    "--quiet",
    "origin",
    `HEAD:refs/pull/${pr.number}/head`,
  );
};

/**
 * A stub `gh` in `dir/bin`, beside `stubClaude`'s. `gh pr view` prints
 * `view` as JSON; every call appends its argv and `GH_TOKEN` to
 * `dir/gh-calls.txt`. Any other command fails.
 */
export const stubGh = async (dir: string, view: unknown): Promise<void> => {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(dir, "gh-view.json"), JSON.stringify(view));
  const script = [
    "#!/bin/sh",
    `printf '%s token=%s\\n' "$*" "$GH_TOKEN" >> "${dir}/gh-calls.txt"`,
    `[ "$1 $2" = "pr view" ] || exit 1`,
    `cat "${dir}/gh-view.json"`,
  ].join("\n");
  await writeFile(path.join(bin, "gh"), `${script}\n`);
  await chmod(path.join(bin, "gh"), 0o755);
};
