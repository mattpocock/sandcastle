/**
 * Vercel isolated sandbox provider — wraps `@vercel/sandbox` into a SandboxProvider.
 *
 * Usage:
 *   import { vercel } from "sandcastle/sandboxes/vercel";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: vercel() });
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  ExecResult,
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import type { SandboxInstance } from "@vercel/sandbox";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

/** Worktree path inside the Vercel sandbox. */
const VERCEL_REPO_PATH = "/vercel/sandbox/workspace";

/**
 * Options for creating a Vercel sandbox provider.
 *
 * All `@vercel/sandbox` `Sandbox.create()` options are accepted as pass-through,
 * plus Sandcastle-specific options for auth and branch strategy.
 */
export interface VercelOptions {
  /**
   * Vercel access token.
   *
   * Falls back to the `VERCEL_TOKEN` environment variable. A token needs a
   * team and project id too (`teamId`/`VERCEL_TEAM_ID`,
   * `projectId`/`VERCEL_PROJECT_ID`). With no token at all, the SDK's OIDC
   * auth applies, which reads `VERCEL_OIDC_TOKEN`.
   */
  readonly token?: string;

  // ---- Pass-through @vercel/sandbox Sandbox.create() options ----

  /**
   * The source of the sandbox (git repo, tarball, or snapshot).
   * Omit to start an empty sandbox.
   */
  readonly source?:
    | {
        type: "git";
        url: string;
        depth?: number;
        revision?: string;
        username?: string;
        password?: string;
      }
    | {
        type: "tarball";
        url: string;
      }
    | {
        type: "snapshot";
        snapshotId: string;
      };

  /** Array of port numbers to expose from the sandbox (up to 4). */
  readonly ports?: number[];

  /** Timeout in milliseconds before the sandbox auto-terminates. */
  readonly timeout?: number;

  /**
   * Resources to allocate to the sandbox.
   * Each vCPU gets 2048 MB of memory.
   */
  readonly resources?: {
    vcpus: number;
  };

  /**
   * The runtime of the sandbox (e.g. `"node24"`, `"node22"`, `"python3.13"`).
   *
   * Omit it to get Vercel's default image (`vercel/sandbox/universal` as of
   * `@vercel/sandbox` 3.x), which ships coding agent CLIs such as `claude`.
   * The named runtimes ship none: install your agent's CLI in an
   * `onSandboxReady` hook.
   */
  readonly runtime?: string;

  /**
   * Network policy for the sandbox.
   * Defaults to full internet access if not specified.
   */
  readonly networkPolicy?: Record<string, unknown>;

  /**
   * Vercel project ID to associate sandbox operations with.
   * Falls back to the `VERCEL_PROJECT_ID` environment variable when a token is used.
   */
  readonly projectId?: string;

  /**
   * Vercel team ID to associate sandbox operations with.
   * Falls back to the `VERCEL_TEAM_ID` environment variable when a token is used.
   */
  readonly teamId?: string;

  /**
   * Timeout in milliseconds (alias for `timeout`, kept for discoverability).
   */
  readonly timeoutMs?: number;

  /**
   * Sandbox template shorthand (e.g. `"node-22"`).
   * Maps to the `runtime` option.
   */
  readonly template?: string;

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;

  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

/** An option or env var counts as unset when it is missing or empty. */
const setOrUndefined = (value: string | undefined): string | undefined =>
  value === "" ? undefined : value;

/**
 * Resolve the auth params for `Sandbox.create()`.
 *
 * `@vercel/sandbox` only accepts a token as an explicit param, together with
 * `teamId` and `projectId` (all three or none); otherwise it falls back to
 * OIDC. So read `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`
 * here, explicit options first.
 */
const resolveVercelAuth = (
  options: VercelOptions | undefined,
): { token?: string; teamId?: string; projectId?: string } => {
  const { env } = process;
  const tokenOption = setOrUndefined(options?.token);
  const teamIdOption = setOrUndefined(options?.teamId);
  const projectIdOption = setOrUndefined(options?.projectId);
  const token = tokenOption ?? setOrUndefined(env.VERCEL_TOKEN);

  if (token === undefined) {
    // No token: the SDK's OIDC flow, which may use team/project ids as hints.
    return {
      ...(teamIdOption === undefined ? {} : { teamId: teamIdOption }),
      ...(projectIdOption === undefined ? {} : { projectId: projectIdOption }),
    };
  }

  const teamId = teamIdOption ?? setOrUndefined(env.VERCEL_TEAM_ID);
  const projectId = projectIdOption ?? setOrUndefined(env.VERCEL_PROJECT_ID);
  const missing = [
    teamId === undefined ? "VERCEL_TEAM_ID (or the teamId option)" : null,
    projectId === undefined
      ? "VERCEL_PROJECT_ID (or the projectId option)"
      : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    const source =
      tokenOption === undefined ? "VERCEL_TOKEN" : "the token option";
    throw new Error(
      `vercel(): ${source} is set, but a Vercel token also needs a team and project id. ` +
        `Missing: ${missing.join(", ")}.`,
    );
  }

  return { token, teamId, projectId };
};

/**
 * Run the setup of a sandbox that `create()` has just made. If it fails, stop
 * the sandbox before rethrowing: no handle exists yet, so neither Sandcastle's
 * teardown nor `close()` can reach it, and it would run until Vercel's
 * timeout.
 */
const setUpOrStop = async (
  sandbox: { stop: () => Promise<unknown> },
  setUp: () => Promise<void>,
): Promise<void> => {
  try {
    await setUp();
  } catch (error) {
    try {
      await sandbox.stop();
    } catch {
      // Report the setup error, which says why create() failed.
    }
    throw error;
  }
};

/** The `Sandbox.create` params: SDK pass-through options, env and auth. */
const toCreateParams = (
  options: VercelOptions | undefined,
  env: Record<string, string>,
): Record<string, unknown> => {
  const o = options ?? {};
  const passThrough: Record<string, unknown> = {
    source: o.source,
    ports: o.ports,
    resources: o.resources,
    networkPolicy: o.networkPolicy,
    // runtime takes precedence over the template convenience alias
    runtime: o.runtime ?? o.template,
    // prefer explicit timeout, fall back to the timeoutMs alias
    timeout: o.timeout ?? o.timeoutMs,
  };
  return {
    // An unset option (or an empty runtime) is left out for the SDK default.
    ...Object.fromEntries(
      Object.entries(passThrough).filter(
        ([, value]) => value !== undefined && value !== "",
      ),
    ),
    env,
    ...resolveVercelAuth(options),
  };
};

type RunCommandParams = Parameters<SandboxInstance["runCommand"]>[0];

/**
 * The command to run for `exec`. `runCommand` gives a command no stdin
 * unless it is detached: the command reads EOF. So write stdin to a file in
 * the sandbox and redirect it in (a file, not an argument, keeps clear of the
 * per-arg size limit). The redirect opens the file before the group runs, so
 * the group can delete it straight away and leave nothing behind.
 */
const withStdin = async (
  sandbox: SandboxInstance,
  command: string,
  stdin: string | undefined,
): Promise<string> => {
  if (stdin === undefined) {
    return command;
  }
  const stdinPath = `/tmp/sandcastle-stdin-${randomUUID()}`;
  await sandbox.writeFiles([{ path: stdinPath, content: Buffer.from(stdin) }]);
  return `{ rm -f ${stdinPath}; ${command}\n} < ${stdinPath}`;
};

/** A stream that hands each stdout line to `onLine` and keeps a bounded tail. */
const lineWritable = (
  onLine: (line: string) => void,
  tail: BoundedTail,
): Writable => {
  let partial = "";
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = partial + chunk.toString();
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        tail.push(line);
        onLine(line);
      }
      callback();
    },
    final(callback) {
      if (partial) {
        tail.push(partial);
        onLine(partial);
        partial = "";
      }
      callback();
    },
  });
};

/** A stream that only keeps a bounded tail of what is written to it. */
const tailWritable = (tail: BoundedTail): Writable =>
  new Writable({
    write(chunk: Buffer, _encoding, callback) {
      tail.push(chunk.toString());
      callback();
    },
  });

/** Run a command, streaming stdout lines to `onLine`; returns bounded tails. */
const execStreamed = async (
  sandbox: SandboxInstance,
  params: RunCommandParams,
  {
    onLine,
    maxOutputTailChars,
  }: {
    readonly onLine: (line: string) => void;
    readonly maxOutputTailChars: number;
  },
): Promise<ExecResult> => {
  const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
  const stderrTail = new BoundedTail(maxOutputTailChars, "");
  const result = await sandbox.runCommand({
    ...params,
    stdout: lineWritable(onLine, stdoutTail),
    stderr: tailWritable(stderrTail),
  });
  return {
    stdout: stdoutTail.toString(),
    stderr: stderrTail.toString(),
    exitCode: result.exitCode,
  };
};

/** Run a command to completion and return its whole output. */
const execBuffered = async (
  sandbox: SandboxInstance,
  params: RunCommandParams,
): Promise<ExecResult> => {
  const result = await sandbox.runCommand(params);
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  return { stdout, stderr, exitCode: result.exitCode };
};

/** Copy a host directory in as a tarball, unpacked at `sandboxPath`. */
const copyDirIn = async (
  sandbox: SandboxInstance,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  const tarPath = join(tmpdir(), `sandcastle-copyin-${Date.now()}.tar.gz`);
  execSync(`tar -czf "${tarPath}" -C "${hostPath}" .`);
  try {
    const tarContent = await readFile(tarPath);
    const sandboxTarPath = `/tmp/sandcastle-copyin-${Date.now()}.tar.gz`;
    await sandbox.writeFiles([{ path: sandboxTarPath, content: tarContent }]);
    await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        `mkdir -p "${sandboxPath}" && tar -xzf "${sandboxTarPath}" -C "${sandboxPath}" && rm -f "${sandboxTarPath}"`,
      ],
    });
  } finally {
    await unlink(tarPath).catch(() => undefined);
  }
};

/**
 * Create the worktree folder with its parents: Vercel's default image has no
 * /vercel/sandbox (its user's home is /vercel), and `mkDir` isn't recursive.
 */
const makeWorktreeDir = async (sandbox: SandboxInstance): Promise<void> => {
  const mkdirResult = await sandbox.runCommand({
    cmd: "mkdir",
    args: ["-p", VERCEL_REPO_PATH],
  });
  if (mkdirResult.exitCode !== 0) {
    const stderr = await mkdirResult.stderr();
    throw new Error(
      `vercel(): could not create ${VERCEL_REPO_PATH}: ${stderr.trim()}`,
    );
  }
};

/** The Sandcastle handle over a Vercel sandbox whose worktree folder exists. */
const makeHandle = (
  sandbox: SandboxInstance,
  maxOutputTailChars: number,
): IsolatedSandboxHandle => ({
  worktreePath: VERCEL_REPO_PATH,
  // `@vercel/sandbox` 2 renamed the sandbox's id from `sandboxId` to `name`.
  sandboxId: sandbox.name ?? sandbox.sandboxId,

  exec: async (command, opts): Promise<ExecResult> => {
    const params: RunCommandParams = {
      cmd: "sh",
      args: ["-c", await withStdin(sandbox, command, opts?.stdin)],
      cwd: opts?.cwd ?? VERCEL_REPO_PATH,
      ...(opts?.sudo === true ? { sudo: true } : {}),
    };
    return opts?.onLine
      ? execStreamed(sandbox, params, {
          onLine: opts.onLine,
          maxOutputTailChars,
        })
      : execBuffered(sandbox, params);
  },

  copyIn: async (hostPath, sandboxPath): Promise<void> => {
    const info = await stat(hostPath);
    if (info.isDirectory()) {
      await copyDirIn(sandbox, hostPath, sandboxPath);
    } else {
      const content = await readFile(hostPath);
      await sandbox.writeFiles([{ path: sandboxPath, content }]);
    }
  },

  copyFileOut: async (sandboxPath, hostPath): Promise<void> => {
    const buffer = await sandbox.readFileToBuffer({ path: sandboxPath });
    if (!buffer) {
      throw new Error(`File not found in Vercel sandbox: ${sandboxPath}`);
    }
    await mkdir(dirname(hostPath), { recursive: true });
    await writeFile(hostPath, buffer);
  },

  close: async (): Promise<void> => {
    await sandbox.stop();
  },
});

/**
 * Create a Vercel isolated sandbox provider.
 *
 * The returned provider creates Vercel Firecracker microVM sandboxes via
 * the `@vercel/sandbox` SDK. Each sandbox is ephemeral — one sandbox per run.
 *
 * Requires `@vercel/sandbox` to be installed as a peer dependency.
 */
export const vercel = (options?: VercelOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "vercel",
    env: options?.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      // Dynamic import so the peer dependency is only loaded at runtime
      const { Sandbox } = await import("@vercel/sandbox");
      const sandbox = await Sandbox.create(
        toCreateParams(options, createOptions.env),
      );
      await setUpOrStop(sandbox, async () => makeWorktreeDir(sandbox));
      return makeHandle(sandbox, options?.maxOutputTailChars ?? MAX_TAIL_CHARS);
    },
  });
