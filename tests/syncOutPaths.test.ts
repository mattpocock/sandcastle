import { execFileSync, spawn } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecResult, IsolatedSandboxHandle } from "@ai-hero/sandcastle";
import {
  claudeCode,
  createIsolatedSandboxProvider,
  run,
} from "@ai-hero/sandcastle";

// Sync-out writes host files at paths an isolated sandbox reports. These
// tests run a whole run() against a local isolated sandbox whose agent step
// is a shell script, and whose answers to sync-out's questions can lie. They
// check that nothing lands outside the host worktree (or in its `.git`).

/** Stream-json for a Claude Code run that just finishes. */
const AGENT_STREAM = [
  { type: "system", subtype: "init", session_id: "sess-syncout" },
  {
    type: "result",
    subtype: "success",
    result: "Done. <promise>COMPLETE</promise>",
  },
].map((event) => JSON.stringify(event));

const sh = async (
  command: string,
  cwd: string,
  onLine?: (line: string) => void,
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (onLine) {
        for (const line of stdout.split("\n")) {
          if (line !== "") {
            onLine(line);
          }
        }
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

const reply = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

interface Script {
  /** Shell run in the sandbox worktree in place of the agent. */
  readonly agent?: string;
  /** Lie about `git ls-files --others`: report these paths, each holding "pwned". */
  readonly untracked?: readonly string[];
  /** Lie about the patch list: report these names. */
  readonly patchNames?: readonly string[];
}

/** A local-directory isolated sandbox that plays `script`. */
const scriptedIsolated = (script: Script) =>
  createIsolatedSandboxProvider({
    name: "scripted-isolated",
    create: async (): Promise<IsolatedSandboxHandle> => {
      const root = await mkdtemp(path.join(tmpdir(), "e2e-isolated-"));
      const worktreePath = path.join(root, "workspace");
      await mkdir(worktreePath);
      return {
        worktreePath,
        exec: async (command, options) => {
          const cwd = options?.cwd ?? worktreePath;
          if (command.startsWith("claude --print")) {
            if (script.agent !== undefined) {
              const result = await sh(script.agent, worktreePath);
              if (result.exitCode !== 0) {
                return result;
              }
            }
            for (const line of AGENT_STREAM) {
              options?.onLine?.(line);
            }
            return reply(AGENT_STREAM.join("\n"));
          }
          if (
            script.untracked !== undefined &&
            command.startsWith("git ls-files --others")
          ) {
            return reply(`${script.untracked.join("\n")}\n`);
          }
          if (script.patchNames !== undefined && command.startsWith("ls -1 ")) {
            return reply(`${script.patchNames.join("\n")}\n`);
          }
          return sh(command, cwd, options?.onLine);
        },
        copyIn: async (hostPath, sandboxPath) => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            await cp(hostPath, sandboxPath, { recursive: true });
          } else {
            await mkdir(path.dirname(sandboxPath), { recursive: true });
            await copyFile(hostPath, sandboxPath);
          }
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          await mkdir(path.dirname(hostPath), { recursive: true });
          await (script.untracked === undefined
            ? copyFile(sandboxPath, hostPath)
            : writeFile(hostPath, "pwned\n"));
        },
        close: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });

/** Every path under `dir` (not following symlinks) whose name starts with `prefix`. */
const findNamed = async (dir: string, prefix: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => path.basename(entry).startsWith(prefix));
};

/** Resolves when `p` does not exist. */
const absent = async (p: string): Promise<void> => {
  await expect(access(p)).rejects.toThrow(/ENOENT/u);
};

/** What `promise` rejected with, as "<name>: <message>"; "resolved" if it didn't. */
const rejection = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(() => "resolved", String);

/** run() rejected with a SyncOutPathError (wrapped in Effect's FiberFailure). */
const REFUSAL = /SyncOutPathError: Refusing to sync /u;

// The sandbox side is POSIX shell (symlinks, `sh -c`).
describe.skipIf(process.platform === "win32")(
  "run() refuses sync-out paths that leave the host worktree",
  () => {
    let root = "";
    let host = "";
    let outside = "";

    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: host, encoding: "utf8" }).trim();

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "e2e-syncout-"));
      host = path.join(root, "host");
      outside = path.join(root, "outside");
      await mkdir(host);
      await mkdir(outside);
      git("init", "-q", "-b", "main");
      await writeFile(path.join(host, "a.txt"), "a\n");
      await writeFile(path.join(host, ".gitignore"), "run.log\n");
      // A tracked symlink that leads out of the worktree.
      await symlink(outside, path.join(host, "link"));
      git("add", ".");
      git("commit", "-q", "-m", "init");
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const runWith = async (script: Script) =>
      run({
        agent: claudeCode("claude-opus-4-8", { captureSessions: false }),
        sandbox: scriptedIsolated(script),
        cwd: host,
        prompt: "Do the task.",
        branchStrategy: { type: "branch", branch: "agent" },
        logging: { type: "file", path: path.join(host, "run.log") },
      });

    it.each([
      ["a '..' path", "../outside/escaped.txt"],
      ["a nested '..' path", "sub/../../outside/escaped.txt"],
      ["a '..' path with backslashes", String.raw`..\outside\escaped.txt`],
    ])("refuses an untracked file at %s", async (_, refused) => {
      const error = await rejection(runWith({ untracked: [refused] }));
      expect(error).toMatch(REFUSAL);
      expect(error).toContain(JSON.stringify(refused));
      await expect(findNamed(root, "escaped")).resolves.toStrictEqual([]);
    });

    it("refuses an untracked file at an absolute path", async () => {
      const refused = path.join(outside, "escaped.txt");
      const error = await rejection(runWith({ untracked: [refused] }));
      expect(error).toMatch(REFUSAL);
      expect(error).toContain(JSON.stringify(refused));
      await expect(findNamed(root, "escaped")).resolves.toStrictEqual([]);
    });

    it("refuses an untracked file inside .git", async () => {
      const refused = ".git/hooks/post-checkout";
      const error = await rejection(runWith({ untracked: [refused] }));
      expect(error).toMatch(REFUSAL);
      expect(error).toContain(JSON.stringify(refused));
      await absent(path.join(host, refused));
      await expect(findNamed(root, "post-checkout")).resolves.toStrictEqual([]);
    });

    it("refuses to write through a host symlink that leads outside", async () => {
      const refused = "link/escaped.txt";
      const error = await rejection(runWith({ untracked: [refused] }));
      expect(error).toMatch(REFUSAL);
      expect(error).toContain(JSON.stringify(refused));
      await expect(readdir(outside)).resolves.toStrictEqual([]);
    });

    it("refuses a patch name that climbs out of the patch directory", async () => {
      const error = await rejection(
        runWith({
          agent: "echo b > b.txt && git add b.txt && git commit -qm b",
          patchNames: ["../../../../escaped.patch"],
        }),
      );
      expect(error).toMatch(REFUSAL);
      await expect(findNamed(root, "escaped")).resolves.toStrictEqual([]);
    });

    it("refuses a commit that makes a symlink leading outside, before applying it", async () => {
      const before = git("rev-parse", "HEAD");
      const error = await rejection(
        runWith({
          agent:
            "ln -s ../../outside evil && git add evil && git commit -qm evil",
        }),
      );
      expect(error).toMatch(REFUSAL);
      expect(error).toContain('"evil"');
      expect(git("rev-parse", "agent")).toBe(before);
      await expect(findNamed(root, "evil")).resolves.toStrictEqual([]);
    });

    it("refuses an uncommitted symlink to an absolute path", async () => {
      const error = await rejection(
        runWith({ agent: `ln -s '${outside}' evil && git add evil` }),
      );
      expect(error).toMatch(REFUSAL);
      expect(error).toContain('"evil"');
      await expect(findNamed(root, "evil")).resolves.toStrictEqual([]);
    });

    it("still syncs symlinks and nested files that stay inside the worktree", async () => {
      const result = await runWith({
        agent:
          "mkdir -p sub && ln -s ../a.txt sub/link && git add sub && git commit -qm link && mkdir -p new/dir && echo n > new/dir/n.txt",
      });
      expect(result.commits).toHaveLength(1);
      // 120000: the commit on the branch holds a symlink.
      expect(git("ls-tree", "agent", "sub/link")).toMatch(/^120000 /u);
      expect(result.preservedWorktreePath).toBeDefined();
      const worktree = String(result.preservedWorktreePath);
      const link = await lstat(path.join(worktree, "sub", "link"));
      expect(link.isSymbolicLink()).toBe(true);
      await expect(
        access(path.join(worktree, "new", "dir", "n.txt")),
      ).resolves.toBeUndefined();
    });
  },
);
