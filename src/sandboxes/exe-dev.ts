/**
 * exe.dev isolated sandbox provider.
 *
 * Each `create()` call provisions a fresh exe.dev VM via the exe.dev CLI
 * (`ssh exe.dev <command>`), then runs commands inside it over SSH.
 * `close()` destroys the VM.
 *
 * The same SSH key authenticates both the exe.dev CLI and VM access — there
 * is no separate API key.
 */

import { spawn } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedCreateOptions,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

const WORKTREE_PATH = "/home/exedev/workspace";
const CONTROL_HOST = "exe.dev";
const DEFAULT_SSH_BOOT_TIMEOUT_MS = 60_000;
const DEFAULT_SSH_POLL_INTERVAL_MS = 1_000;
const SSH_HOST_SUFFIX = ".exe.xyz";
const DEFAULT_SSH_KEY_PATH = "~/.ssh/id_exe";

/** Options for the exe.dev sandbox provider. */
export interface ExeDevOptions {
  /**
   * Path to the SSH private key authorized on your exe.dev account.
   * `~` is expanded to the current user's home directory.
   *
   * The same key authenticates both the CLI (`ssh exe.dev <command>`) and VM
   * access (`ssh <vm>.exe.xyz`).
   *
   * When set, `ssh`/`scp` are run with `-i <path> -o IdentitiesOnly=yes` and
   * `SSH_AUTH_SOCK` is stripped from the child env, so the SSH agent is
   * bypassed entirely.
   *
   * Defaults to `~/.ssh/id_exe` (exe.dev's recommended key location) if that
   * file exists. If neither this option nor the default file is present,
   * `ssh`/`scp` fall back to their normal lookup — the running SSH agent's
   * keys plus `~/.ssh/id_*` defaults.
   */
  readonly sshKeyPath?: string;

  /**
   * SSH user to connect as inside the VM. Leave undefined to fall back to
   * SSH config / current OS user.
   */
  readonly sshUser?: string;

  /**
   * Maximum time in ms to wait for SSH to become reachable after VM creation.
   * @default 60000
   */
  readonly sshBootTimeoutMs?: number;

  /**
   * Tags to apply to provisioned VMs.
   *
   * Defaults to `["sandcastle"]` so every VM created by this provider is
   * identifiable at a glance in the exe.dev panel. Pass an explicit array to
   * override (e.g. `["sandcastle", "production"]` or `[]` for no tags).
   *
   * @default ["sandcastle"]
   */
  readonly tags?: readonly string[];

  /**
   * Environment variables injected by this provider. Merged with Sandcastle's
   * env at launch time and exported into the remote shell on every `exec()`.
   */
  readonly env?: Record<string, string>;
}

const DEFAULT_TAGS: readonly string[] = ["sandcastle"];

interface ResolvedOptions {
  readonly sshKeyPath: string | undefined;
  readonly sshUser: string | undefined;
  readonly sshBootTimeoutMs: number;
  readonly tags: readonly string[];
}

/**
 * Create an exe.dev isolated sandbox provider.
 *
 * @example
 * ```ts
 * import { run, claudeCode } from "@ai-hero/sandcastle";
 * import { exeDev } from "@ai-hero/sandcastle/sandboxes/exe-dev";
 *
 * // Zero-config: uses ~/.ssh/id_exe automatically if it exists
 * await run({
 *   agent: claudeCode("claude-opus-4-6"),
 *   sandbox: exeDev(),
 *   prompt: "...",
 * });
 * ```
 */
export const exeDev = (options?: ExeDevOptions): IsolatedSandboxProvider => {
  const explicitKeyPath = options?.sshKeyPath !== undefined;
  const resolved: ResolvedOptions = {
    sshKeyPath: options?.sshKeyPath
      ? expandHome(options.sshKeyPath)
      : undefined,
    sshUser: options?.sshUser,
    sshBootTimeoutMs: options?.sshBootTimeoutMs ?? DEFAULT_SSH_BOOT_TIMEOUT_MS,
    tags: options?.tags ?? DEFAULT_TAGS,
  };

  return createIsolatedSandboxProvider({
    name: "exe-dev",
    env: options?.env,
    create: async (
      createOptions: IsolatedCreateOptions,
    ): Promise<IsolatedSandboxHandle> => {
      let effectiveKeyPath = resolved.sshKeyPath;
      if (explicitKeyPath) {
        await assertKeyReadable(effectiveKeyPath!);
      } else {
        const defaultKey = expandHome(DEFAULT_SSH_KEY_PATH);
        try {
          await access(defaultKey);
          effectiveKeyPath = defaultKey;
        } catch {
          // Default key not found — fall back to SSH agent / default key lookup
        }
      }
      const effectiveResolved: ResolvedOptions =
        effectiveKeyPath !== resolved.sshKeyPath
          ? { ...resolved, sshKeyPath: effectiveKeyPath }
          : resolved;

      const vmName = await controlCreateVm(effectiveResolved);
      const sshHost = `${vmName}${SSH_HOST_SUFFIX}`;
      const sshTarget = effectiveResolved.sshUser
        ? `${effectiveResolved.sshUser}@${sshHost}`
        : sshHost;

      try {
        await waitForSsh(sshTarget, effectiveResolved);
        await sshExec(
          sshTarget,
          effectiveResolved,
          `mkdir -p ${shellQuote(WORKTREE_PATH)}`,
        );
      } catch (err) {
        await controlDestroyVm(vmName, effectiveResolved).catch(() => {});
        throw err;
      }

      const handle: IsolatedSandboxHandle = {
        worktreePath: WORKTREE_PATH,

        exec: (command, opts) =>
          execOverSsh({
            sshTarget,
            resolved: effectiveResolved,
            command,
            opts,
            defaultCwd: WORKTREE_PATH,
            env: createOptions.env,
          }),

        copyIn: (hostPath, sandboxPath) =>
          scpIn({
            sshTarget,
            resolved: effectiveResolved,
            hostPath,
            sandboxPath,
          }),

        copyFileOut: (sandboxPath, hostPath) =>
          scpOut({
            sshTarget,
            resolved: effectiveResolved,
            sandboxPath,
            hostPath,
          }),

        close: async () => {
          await controlDestroyVm(vmName, effectiveResolved).catch(() => {});
        },
      };

      return handle;
    },
  });
};

// ---------------------------------------------------------------------------
// exe.dev CLI (over SSH to `exe.dev`)
// ---------------------------------------------------------------------------

async function controlCreateVm(opts: ResolvedOptions): Promise<string> {
  const tagFlags = opts.tags.map((t) => `--tag=${t}`).join(" ");
  const tagsPart = tagFlags.length > 0 ? ` ${tagFlags}` : "";
  // `--json` for structured output; `-no-email` suppresses the creation email.
  const json = await controlExec(`new --json -no-email${tagsPart}`, opts);
  const name = extractVmName(json);
  if (!name) {
    throw new Error(
      `exe.dev: could not parse VM name from response: ${JSON.stringify(json)}`,
    );
  }
  return name;
}

async function controlDestroyVm(
  vmName: string,
  opts: ResolvedOptions,
): Promise<void> {
  await controlExec(`rm --json ${vmName}`, opts);
}

async function controlExec(
  command: string,
  opts: ResolvedOptions,
): Promise<unknown> {
  const target = opts.sshUser
    ? `${opts.sshUser}@${CONTROL_HOST}`
    : CONTROL_HOST;
  const result = await runSsh({
    sshTarget: target,
    sshKeyPath: opts.sshKeyPath,
    remoteCommand: command,
  });
  return parseControlResponse(command, result);
}

function parseControlResponse(command: string, result: ExecResult): unknown {
  if (result.exitCode !== 0) {
    const raw =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string"
      ) {
        detail = (parsed as { error: string }).error;
      }
    } catch {
      /* not JSON — use raw */
    }
    throw new Error(`exe.dev: ${detail}`);
  }
  const text = result.stdout.trim();
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `exe.dev control: non-JSON response for "${command}": ${text}`,
    );
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const errMsg = (parsed as { error: unknown }).error;
    throw new Error(
      `exe.dev control command "${command}" failed: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}`,
    );
  }
  return parsed;
}

function extractVmName(json: unknown): string | undefined {
  if (typeof json === "string") {
    const trimmed = json.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const key of [
      "vm_name",
      "name",
      "vm",
      "vmname",
      "id",
      "ssh_dest",
      "host",
    ]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) {
        return v.endsWith(SSH_HOST_SUFFIX)
          ? v.slice(0, -SSH_HOST_SUFFIX.length)
          : v;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SSH execution
// ---------------------------------------------------------------------------

interface ExecArgs {
  readonly sshTarget: string;
  readonly resolved: ResolvedOptions;
  readonly command: string;
  readonly opts:
    | {
        onLine?: (line: string) => void;
        cwd?: string;
        sudo?: boolean;
        stdin?: string;
      }
    | undefined;
  readonly defaultCwd: string;
  readonly env: Record<string, string>;
}

async function execOverSsh(args: ExecArgs): Promise<ExecResult> {
  const { sshTarget, resolved, command, opts, defaultCwd, env } = args;
  const cwd = opts?.cwd ?? defaultCwd;

  const envExports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("; ");

  const sudoPrefix = opts?.sudo
    ? `sudo -E sh -c ${shellQuote(command)}`
    : command;
  const remoteCmd = [`cd ${shellQuote(cwd)}`, envExports, sudoPrefix]
    .filter((s) => s.length > 0)
    .join(" && ");

  return runSsh({
    sshTarget,
    sshKeyPath: resolved.sshKeyPath,
    remoteCommand: remoteCmd,
    onLine: opts?.onLine,
    stdin: opts?.stdin,
  });
}

interface RunSshArgs {
  readonly sshTarget: string;
  readonly sshKeyPath: string | undefined;
  readonly remoteCommand: string;
  readonly onLine?: ((line: string) => void) | undefined;
  readonly stdin?: string | undefined;
  readonly connectTimeoutSec?: number | undefined;
}

/**
 * Build the OpenSSH option array shared by `ssh` and `scp` invocations.
 *
 * When `sshKeyPath` is set, lock OpenSSH to exactly that key. When omitted,
 * leave OpenSSH to its default lookup so the running agent and `~/.ssh/id_*`
 * defaults are tried.
 */
function buildSshFlags(sshKeyPath: string | undefined): string[] {
  const flags = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "BatchMode=yes",
  ];
  if (sshKeyPath !== undefined) {
    return ["-i", sshKeyPath, "-o", "IdentitiesOnly=yes", ...flags];
  }
  return flags;
}

function spawnEnvFor(
  sshKeyPath: string | undefined,
): NodeJS.ProcessEnv | undefined {
  return sshKeyPath !== undefined ? envWithoutAgent() : undefined;
}

function runSsh(args: RunSshArgs): Promise<ExecResult> {
  return new Promise((resolveP, reject) => {
    const sshArgs = [
      ...buildSshFlags(args.sshKeyPath),
      "-o",
      `ConnectTimeout=${args.connectTimeoutSec ?? 10}`,
      args.sshTarget,
      args.remoteCommand,
    ];
    const childEnv = spawnEnvFor(args.sshKeyPath);
    const proc = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(childEnv !== undefined ? { env: childEnv } : {}),
    });

    const stdoutLines: string[] = [];
    const stderrChunks: string[] = [];
    let partial = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        stdoutLines.push(line);
        args.onLine?.(line);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    proc.on("error", (err) =>
      reject(new Error(`ssh spawn failed: ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (partial.length > 0) {
        stdoutLines.push(partial);
        args.onLine?.(partial);
        partial = "";
      }
      resolveP({
        stdout: stdoutLines.join("\n"),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 0,
      });
    });

    if (args.stdin !== undefined) {
      proc.stdin.end(args.stdin);
    } else {
      proc.stdin.end();
    }
  });
}

async function sshExec(
  sshTarget: string,
  resolved: ResolvedOptions,
  remoteCommand: string,
): Promise<ExecResult> {
  const result = await runSsh({
    sshTarget,
    sshKeyPath: resolved.sshKeyPath,
    remoteCommand,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `SSH command failed (exit ${result.exitCode}): ${remoteCommand}\n${result.stderr}`,
    );
  }
  return result;
}

async function waitForSsh(
  sshTarget: string,
  resolved: ResolvedOptions,
): Promise<void> {
  const deadline = Date.now() + resolved.sshBootTimeoutMs;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    try {
      const result = await runSsh({
        sshTarget,
        sshKeyPath: resolved.sshKeyPath,
        remoteCommand: "true",
        connectTimeoutSec: 5,
      });
      if (result.exitCode === 0) return;
      lastError = result.stderr.trim() || `exit ${result.exitCode}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(DEFAULT_SSH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${resolved.sshBootTimeoutMs}ms waiting for SSH to ${sshTarget}: ${lastError ?? "unknown"}`,
  );
}

// ---------------------------------------------------------------------------
// SCP file transfer
// ---------------------------------------------------------------------------

interface ScpInArgs {
  readonly sshTarget: string;
  readonly resolved: ResolvedOptions;
  readonly hostPath: string;
  readonly sandboxPath: string;
}

async function scpIn(args: ScpInArgs): Promise<void> {
  await sshExec(
    args.sshTarget,
    args.resolved,
    `mkdir -p ${shellQuote(dirname(args.sandboxPath))}`,
  );
  await runScp(args.resolved.sshKeyPath, [
    ...buildSshFlags(args.resolved.sshKeyPath),
    "-r",
    args.hostPath,
    `${args.sshTarget}:${args.sandboxPath}`,
  ]);
}

interface ScpOutArgs {
  readonly sshTarget: string;
  readonly resolved: ResolvedOptions;
  readonly sandboxPath: string;
  readonly hostPath: string;
}

async function scpOut(args: ScpOutArgs): Promise<void> {
  await mkdir(dirname(args.hostPath), { recursive: true });
  await runScp(args.resolved.sshKeyPath, [
    ...buildSshFlags(args.resolved.sshKeyPath),
    `${args.sshTarget}:${args.sandboxPath}`,
    args.hostPath,
  ]);
}

function runScp(
  sshKeyPath: string | undefined,
  scpArgs: string[],
): Promise<void> {
  return new Promise((resolveP, reject) => {
    const childEnv = spawnEnvFor(sshKeyPath);
    const proc = spawn("scp", scpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(childEnv !== undefined ? { env: childEnv } : {}),
    });
    const stderrChunks: Buffer[] = [];
    proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    proc.on("error", (err) =>
      reject(new Error(`scp spawn failed: ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (code === 0) {
        resolveP();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        reject(new Error(`scp failed (exit ${code}): ${stderr}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

async function assertKeyReadable(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(
      `exeDev: SSH key not readable at ${path}. Pass an existing private key path to \`sshKeyPath\`.`,
    );
  }
}

/**
 * Returns a copy of `process.env` with SSH agent variables stripped, so that
 * `ssh -i` / `scp -i` use only the file we pass and never consult the SSH
 * agent. Combined with `IdentitiesOnly=yes`, this guarantees no agent prompts
 * and no key-leak across multi-key setups.
 */
function envWithoutAgent(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e["SSH_AUTH_SOCK"];
  delete e["SSH_AGENT_PID"];
  return e;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
