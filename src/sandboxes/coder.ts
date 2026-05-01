import { spawn, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type InteractiveExecOptions,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

export type CoderOnClose = "delete" | "stop" | "leave";

export interface CoderCommonOptions {
  readonly url?: string;
  readonly token?: string;
  readonly env?: Record<string, string>;
  readonly onClose: CoderOnClose;
  readonly workspaceAgent?: string;
  readonly workdir?: string;
}

export interface CoderCreateFromTemplateOptions extends CoderCommonOptions {
  readonly template: string;
  readonly workspace?: never;
  readonly templateVersion?: string;
  readonly parameters?: Record<string, string | number | boolean>;
  readonly parameterFile?: string;
  readonly preset?: string;
  readonly workspaceName?: string;
  readonly organization?: string;
}

export interface CoderAttachToWorkspaceOptions extends CoderCommonOptions {
  readonly workspace: string;
  readonly template?: never;
  readonly owner?: string;
}

export type CoderOptions =
  | CoderCreateFromTemplateOptions
  | CoderAttachToWorkspaceOptions;

interface CoderCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface CoderWorkspaceAgent {
  readonly name: string;
  readonly status?: string;
  readonly directory?: string;
}

interface CoderWorkspace {
  readonly id?: string;
  readonly name: string;
  readonly owner_name?: string;
  readonly deleting_at?: string | null;
  readonly latest_build?: {
    readonly status?: string;
    readonly resources?: ReadonlyArray<{
      readonly agents?: ReadonlyArray<CoderWorkspaceAgent>;
    }>;
  };
}

interface ResolvedCoderWorkspace {
  readonly workspace: CoderWorkspace;
  readonly workspaceRef: string;
  readonly sshRef: string;
  readonly agent: CoderWorkspaceAgent;
  readonly sshHostname: string;
  readonly worktreePath: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isCreateOptions = (
  options: CoderOptions,
): options is CoderCreateFromTemplateOptions => "template" in options;

function assertNonEmptyString(
  value: unknown,
  description: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
}

function assertRemoteAbsolutePath(value: string, description: string): void {
  assertNonEmptyString(value, description);
  if (!value.startsWith("/")) {
    throw new Error(`${description} must be an absolute path, got ${value}`);
  }
}

const assertWorkspaceArray = (value: unknown): CoderWorkspace[] => {
  if (!Array.isArray(value)) {
    throw new Error("Expected `coder list -o json` to return an array");
  }

  return value.map((workspace, index) => {
    if (workspace === null || typeof workspace !== "object") {
      throw new Error(`Coder workspace at index ${index} is not an object`);
    }
    const candidate = workspace as { name?: unknown };
    assertNonEmptyString(
      candidate.name,
      `Coder workspace at index ${index}.name`,
    );
    return workspace as CoderWorkspace;
  });
};

const shellQuote = (value: string): string => {
  assertNonEmptyString(value, "shell value");
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

const displayCommand = (binary: string, args: readonly string[]): string =>
  [binary, ...args].map((arg) => shellQuote(arg)).join(" ");

const coderEnv = (options: CoderOptions): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.url !== undefined) {
    assertNonEmptyString(options.url, "Coder URL");
    env.CODER_URL = options.url;
  }
  if (options.token !== undefined) {
    assertNonEmptyString(options.token, "Coder session token");
    env.CODER_SESSION_TOKEN = options.token;
  }
  return env;
};

// `binary` is `"ssh"` only when the caller needs stdin EOF propagation
// (copyFileIn, copyFileOut, exec with stdin); `coder ssh -- <cmd>` does not
// half-close the remote stdin, so commands like `cat` or `claude --print -p -`
// hang. OpenSSH via `ProxyCommand=coder ssh --stdio ...` handles EOF
// correctly. See coder/coder#24861.
const runChildProcess = (
  binary: "coder" | "ssh",
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdin?: string;
    readonly onStdoutLine?: (line: string) => void;
  },
): Promise<CoderCommandResult> => {
  if (args.length === 0) {
    throw new Error(`${binary} requires at least one CLI argument`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(binary, [...args], {
      env: options.env,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (options.stdin !== undefined) {
      proc.stdin!.write(options.stdin);
      proc.stdin!.end();
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    if (options.onStdoutLine) {
      const onStdoutLine = options.onStdoutLine;
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        stdoutChunks.push(line);
        onStdoutLine(line);
      });
    } else {
      proc.stdout!.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString());
      });
    }

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    proc.on("error", (error: Error) => {
      reject(
        new Error(
          `Failed to start ${displayCommand(binary, args)}: ${error.message}`,
        ),
      );
    });

    proc.on("close", (code: number | null) => {
      resolve({
        stdout: stdoutChunks.join(options.onStdoutLine ? "\n" : ""),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 0,
      });
    });
  });
};

const runCoder = (
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdin?: string;
    readonly onStdoutLine?: (line: string) => void;
  },
): Promise<CoderCommandResult> => runChildProcess("coder", args, options);

const runOpenSsh = (
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdin?: string;
    readonly onStdoutLine?: (line: string) => void;
  },
): Promise<CoderCommandResult> => runChildProcess("ssh", args, options);

const runCoderChecked = async (
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdin?: string },
  description: string,
): Promise<CoderCommandResult> => {
  const result = await runCoder(args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${description} failed with exit code ${result.exitCode}: ${displayCommand("coder", args)}\n${result.stderr}${result.stdout}`,
    );
  }
  return result;
};

const runCoderJson = async <T>(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  description: string,
): Promise<T> => {
  const result = await runCoderChecked(args, { env }, description);
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${description} returned invalid JSON: ${message}\nstdout:\n${result.stdout}`,
    );
  }
};

const preflightCoder = async (env: NodeJS.ProcessEnv): Promise<void> => {
  await runCoderJson<unknown>(["whoami", "-o", "json"], env, "Coder preflight");
};

const listWorkspaces = async (
  env: NodeJS.ProcessEnv,
  options?: { readonly search?: string; readonly all?: boolean },
): Promise<CoderWorkspace[]> => {
  const args = ["list", "-o", "json"];
  if (options?.all) args.push("--all");
  if (options?.search) args.push("--search", options.search);
  return assertWorkspaceArray(
    await runCoderJson<unknown>(args, env, "Listing Coder workspaces"),
  );
};

const getWorkspaceRef = (workspace: CoderWorkspace): string => {
  assertNonEmptyString(workspace.name, "Coder workspace name");
  if (workspace.owner_name) return `${workspace.owner_name}/${workspace.name}`;
  if (workspace.id) return workspace.id;
  return workspace.name;
};

const exactWorkspaceName = (
  workspaces: readonly CoderWorkspace[],
  name: string,
  ownerName?: string,
): CoderWorkspace | undefined =>
  workspaces.find(
    (workspace) =>
      workspace.name === name &&
      (ownerName === undefined || workspace.owner_name === ownerName),
  );

const resolveCreatedWorkspace = async (
  env: NodeJS.ProcessEnv,
  workspaceName: string,
): Promise<CoderWorkspace> => {
  const searched = await listWorkspaces(env, {
    search: `owner:me name:${workspaceName}`,
  });
  const searchHit = exactWorkspaceName(searched, workspaceName);
  if (searchHit) return searchHit;

  const all = await listWorkspaces(env, { all: true });
  const allHit = exactWorkspaceName(all, workspaceName);
  if (allHit) return allHit;

  throw new Error(
    `Could not resolve newly-created Coder workspace ${workspaceName} from coder list -o json`,
  );
};

const resolveWorkspaceById = async (
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<CoderWorkspace | undefined> => {
  const workspaces = await listWorkspaces(env, { all: true });
  return workspaces.find((workspace) => workspace.id === id);
};

const resolveAttachedWorkspace = async (
  env: NodeJS.ProcessEnv,
  options: CoderAttachToWorkspaceOptions,
): Promise<CoderWorkspace> => {
  assertNonEmptyString(options.workspace, "Coder workspace");

  if (uuidPattern.test(options.workspace)) {
    const workspace = await resolveWorkspaceById(env, options.workspace);
    if (!workspace) {
      throw new Error(
        `Could not find Coder workspace with ID ${options.workspace} using coder list --all -o json`,
      );
    }
    return workspace;
  }

  if (options.workspace.includes("/") && options.owner !== undefined) {
    throw new Error(
      'Pass either `workspace: "owner/name"` or `owner`, not both, for Coder attach mode',
    );
  }

  const workspaceParts = options.workspace.split("/");
  if (options.workspace.includes("/") && workspaceParts.length !== 2) {
    throw new Error(
      'Coder workspace must be either "name" or "owner/name" in attach mode',
    );
  }

  const [workspaceOwner, workspaceName] = options.workspace.includes("/")
    ? (workspaceParts as [string, string])
    : [options.owner ?? "me", options.workspace];
  assertNonEmptyString(workspaceOwner, "Coder workspace owner");
  assertNonEmptyString(workspaceName, "Coder workspace name");

  const searched = await listWorkspaces(env, {
    search: `owner:${workspaceOwner} name:${workspaceName}`,
  });
  const searchHit = exactWorkspaceName(
    searched,
    workspaceName,
    workspaceOwner === "me" ? undefined : workspaceOwner,
  );
  if (searchHit) return searchHit;

  throw new Error(
    `Could not find Coder workspace ${workspaceOwner}/${workspaceName} using coder list -o json`,
  );
};

const refreshWorkspace = async (
  env: NodeJS.ProcessEnv,
  workspace: CoderWorkspace,
): Promise<CoderWorkspace> => {
  if (workspace.id) {
    const byId = await resolveWorkspaceById(env, workspace.id);
    if (byId) return byId;
  }

  const workspaceRef = getWorkspaceRef(workspace);
  if (workspaceRef.includes("/")) {
    const [owner, name] = workspaceRef.split("/", 2) as [string, string];
    const searched = await listWorkspaces(env, {
      search: `owner:${owner} name:${name}`,
    });
    const byName = exactWorkspaceName(searched, name, owner);
    if (byName) return byName;
  }

  return workspace;
};

const buildAgents = (workspace: CoderWorkspace): CoderWorkspaceAgent[] => {
  const agents: CoderWorkspaceAgent[] = [];
  for (const resource of workspace.latest_build?.resources ?? []) {
    for (const agent of resource.agents ?? []) {
      assertNonEmptyString(
        agent.name,
        `Coder workspace agent name for ${workspace.name}`,
      );
      agents.push(agent);
    }
  }
  return agents;
};

const selectWorkspaceAgent = (
  workspace: CoderWorkspace,
  workspaceAgent: string | undefined,
): CoderWorkspaceAgent => {
  const agents = buildAgents(workspace);
  if (agents.length === 0) {
    throw new Error(
      `Coder workspace ${getWorkspaceRef(workspace)} has no workspace agents in coder list -o json`,
    );
  }

  const selected = workspaceAgent
    ? agents.find((agent) => agent.name === workspaceAgent)
    : agents.length === 1
      ? agents[0]
      : undefined;

  if (!selected) {
    const names = agents.map((agent) => agent.name).join(", ");
    throw new Error(
      workspaceAgent
        ? `Coder workspace ${getWorkspaceRef(workspace)} does not have a workspace agent named ${workspaceAgent}. Available workspace agents: ${names}`
        : `Coder workspace ${getWorkspaceRef(workspace)} has multiple workspace agents (${names}); set coder({ workspaceAgent: "..." })`,
    );
  }

  if (selected.status !== "connected") {
    throw new Error(
      `Coder workspace agent ${selected.name} for ${getWorkspaceRef(workspace)} is not connected (status: ${selected.status ?? "unknown"})`,
    );
  }

  return selected;
};

const WORKSPACE_AGENT_POLL_ATTEMPTS = 60;
const WORKSPACE_AGENT_POLL_INTERVAL_MS = 1_000;

// Coder prebuild claims can briefly report the new agent as `connected` while
// the prior prebuild agent is still shutting down. The first `coder ssh` after
// claim then lands on the disconnecting agent and fails with
// `error: agent is shutting down`. Probe with `printf ready` until SSH
// successfully round-trips real bytes; in practice the race resolves within
// ~30s of the claim, so 60s is a generous guard.
const SSH_READY_POLL_ATTEMPTS = 30;
const SSH_READY_POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getWorkspaceAgentRetryReason = (
  workspace: CoderWorkspace,
  workspaceAgent: string | undefined,
): string | undefined => {
  const agents = buildAgents(workspace);
  if (agents.length === 0) return "has no workspace agents yet";

  if (workspaceAgent !== undefined) {
    const selected = agents.find((agent) => agent.name === workspaceAgent);
    if (selected && selected.status !== "connected") {
      return `workspace agent ${workspaceAgent} is ${selected.status ?? "unknown"}`;
    }
    return undefined;
  }

  if (agents.length === 1 && agents[0]!.status !== "connected") {
    return `workspace agent ${agents[0]!.name} is ${agents[0]!.status ?? "unknown"}`;
  }

  return undefined;
};

const waitForWorkspaceAgents = async (
  env: NodeJS.ProcessEnv,
  initialWorkspace: CoderWorkspace,
  workspaceAgent: string | undefined,
): Promise<CoderWorkspace> => {
  let workspace = initialWorkspace;

  for (let attempt = 0; attempt < WORKSPACE_AGENT_POLL_ATTEMPTS; attempt++) {
    const retryReason = getWorkspaceAgentRetryReason(workspace, workspaceAgent);
    if (!retryReason) return workspace;

    if (attempt === WORKSPACE_AGENT_POLL_ATTEMPTS - 1) {
      throw new Error(
        `Coder workspace ${getWorkspaceRef(workspace)} ${retryReason} after waiting ${WORKSPACE_AGENT_POLL_ATTEMPTS * WORKSPACE_AGENT_POLL_INTERVAL_MS}ms`,
      );
    }

    await sleep(WORKSPACE_AGENT_POLL_INTERVAL_MS);
    workspace = await refreshWorkspace(env, workspace);
  }

  return workspace;
};

// See SSH_READY_POLL_* for why this exists.
const waitForSshReady = async (
  env: NodeJS.ProcessEnv,
  sshRef: string,
): Promise<void> => {
  assertNonEmptyString(sshRef, "Coder SSH ref");

  let lastResult: CoderCommandResult | undefined;
  for (let attempt = 0; attempt < SSH_READY_POLL_ATTEMPTS; attempt++) {
    const result = await runCoder(
      buildSshArgs(sshRef, {}, remoteShell("printf ready")),
      { env },
    );
    lastResult = result;

    // `coder ssh` may prepend release-candidate banner lines on stdout, so
    // require `endsWith("ready")` rather than equality.
    if (result.exitCode === 0 && result.stdout.trim().endsWith("ready")) {
      return;
    }

    if (attempt === SSH_READY_POLL_ATTEMPTS - 1) break;
    await sleep(SSH_READY_POLL_INTERVAL_MS);
  }

  const exit = lastResult?.exitCode ?? "unknown";
  const stderr = lastResult?.stderr ?? "";
  const stdout = lastResult?.stdout ?? "";
  throw new Error(
    `Coder SSH ${sshRef} was not ready after waiting ${SSH_READY_POLL_ATTEMPTS * SSH_READY_POLL_INTERVAL_MS}ms; last exit code ${exit}\nstderr:\n${stderr}\nstdout:\n${stdout}`,
  );
};

const getBuildStatus = (workspace: CoderWorkspace): string | undefined =>
  workspace.latest_build?.status;

const ensureAttachableWorkspace = async (
  env: NodeJS.ProcessEnv,
  workspace: CoderWorkspace,
): Promise<CoderWorkspace> => {
  const status = getBuildStatus(workspace);
  const workspaceRef = getWorkspaceRef(workspace);

  if (workspace.deleting_at || status === "deleting" || status === "deleted") {
    throw new Error(`Coder workspace ${workspaceRef} is deleting or deleted`);
  }

  if (status === "failed" || status === "canceled" || status === "canceling") {
    throw new Error(
      `Coder workspace ${workspaceRef} latest build is ${status}`,
    );
  }

  if (status !== "stopped") return workspace;

  await runCoderChecked(
    ["start", workspaceRef, "--yes"],
    { env },
    `Starting Coder workspace ${workspaceRef}`,
  );

  if (workspace.id) {
    const resolved = await resolveWorkspaceById(env, workspace.id);
    if (resolved) return resolved;
  }

  return workspace;
};

const buildSshHostname = (workspaceRef: string, agentName: string): string => {
  assertNonEmptyString(workspaceRef, "Coder workspace ref");
  assertNonEmptyString(agentName, "Coder workspace agent name");
  const workspaceHost = workspaceRef.includes("/")
    ? workspaceRef.replace("/", "--")
    : workspaceRef;
  return `${workspaceHost}.${agentName}.coder`;
};

const buildOpenSshArgs = (
  sshHostname: string,
  remoteCommand: string,
): string[] => [
  "-F",
  "/dev/null",
  "-o",
  "ConnectTimeout=0",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ProxyCommand=coder ssh --stdio --hostname-suffix coder %h",
  sshHostname,
  remoteCommand,
];

const assertEnvKey = (key: string): void => {
  assertNonEmptyString(key, "Coder SSH env key");
  if (key.includes("=")) {
    throw new Error(`Coder SSH env key must not contain '=': ${key}`);
  }
};

const buildSshArgs = (
  sshRef: string,
  sandboxEnv: Record<string, string>,
  remoteArgs: readonly string[],
): string[] => {
  const args = ["ssh"];
  for (const [key, value] of Object.entries(sandboxEnv)) {
    assertEnvKey(key);
    args.push("--env", `${key}=${value}`);
  }
  args.push(sshRef, "--", ...remoteArgs);
  return args;
};

const remoteShell = (command: string): string[] => [
  `sh -c ${shellQuote(command)}`,
];

/**
 * Build a `KEY1='V1' KEY2='V2' ` shell prefix that scopes env vars on the
 * OpenSSH path. OpenSSH has no `--env KEY=VAL` flag like `coder ssh` does,
 * so we inline the assignments before the actual remote command. Returns
 * an empty string when `sandboxEnv` is empty so call sites stay uniform.
 */
const buildEnvPrefix = (sandboxEnv: Record<string, string>): string => {
  const entries = Object.entries(sandboxEnv);
  if (entries.length === 0) return "";
  for (const [key] of entries) assertEnvKey(key);
  return `${entries
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")} `;
};

const ensureRemoteDirectory = async (
  env: NodeJS.ProcessEnv,
  sshRef: string,
  directory: string,
): Promise<void> => {
  assertRemoteAbsolutePath(directory, "Coder remote directory");
  await runCoderChecked(
    buildSshArgs(
      sshRef,
      {},
      remoteShell(`mkdir -p -- ${shellQuote(directory)}`),
    ),
    { env },
    `Creating Coder remote directory ${directory}`,
  );
};

const resolveRemoteHome = async (
  env: NodeJS.ProcessEnv,
  sshRef: string,
): Promise<string> => {
  const result = await runCoderChecked(
    buildSshArgs(sshRef, {}, remoteShell('printf %s "$HOME"')),
    { env },
    `Resolving Coder remote home for ${sshRef}`,
  );
  const home = result.stdout.trim();
  assertRemoteAbsolutePath(home, "Coder remote home");
  return home;
};

const resolveWorktreePath = async (
  env: NodeJS.ProcessEnv,
  options: CoderOptions,
  sshRef: string,
  agent: CoderWorkspaceAgent,
): Promise<string> => {
  if (options.workdir !== undefined) {
    assertRemoteAbsolutePath(options.workdir, "coder({ workdir })");
    return options.workdir;
  }

  if (agent.directory && agent.directory.startsWith("/")) {
    return posix.join(agent.directory, ".sandcastle", "worktree");
  }

  const remoteHome = await resolveRemoteHome(env, sshRef);
  return posix.join(remoteHome, ".sandcastle", "worktree");
};

const resolveCoderWorkspace = async (
  env: NodeJS.ProcessEnv,
  options: CoderOptions,
): Promise<ResolvedCoderWorkspace> => {
  let workspace: CoderWorkspace;

  if (isCreateOptions(options)) {
    workspace = await resolveCreatedWorkspace(env, options.workspaceName!);
  } else {
    workspace = await ensureAttachableWorkspace(
      env,
      await resolveAttachedWorkspace(env, options),
    );
  }

  workspace = await waitForWorkspaceAgents(
    env,
    workspace,
    options.workspaceAgent,
  );
  const workspaceRef = getWorkspaceRef(workspace);
  const agent = selectWorkspaceAgent(workspace, options.workspaceAgent);
  const sshRef = `${workspaceRef}.${agent.name}`;
  const sshHostname = buildSshHostname(workspaceRef, agent.name);
  await waitForSshReady(env, sshRef);
  const worktreePath = await resolveWorktreePath(env, options, sshRef, agent);
  await ensureRemoteDirectory(env, sshRef, worktreePath);

  return { workspace, workspaceRef, sshRef, sshHostname, agent, worktreePath };
};

const createWorkspaceName = (): string =>
  `sandcastle-${randomBytes(4).toString("hex")}`;

const createCoderWorkspace = async (
  env: NodeJS.ProcessEnv,
  options: CoderCreateFromTemplateOptions,
  workspaceName: string,
): Promise<void> => {
  const args = ["create", workspaceName, "--template", options.template];

  if (options.templateVersion) {
    args.push("--template-version", options.templateVersion);
  }
  for (const [key, value] of Object.entries(options.parameters ?? {})) {
    assertNonEmptyString(key, "Coder template parameter key");
    args.push("--parameter", `${key}=${String(value)}`);
  }
  if (options.parameterFile) {
    args.push("--rich-parameter-file", options.parameterFile);
  }
  if (options.preset) {
    args.push("--preset", options.preset);
  }
  if (options.organization) {
    args.push("--org", options.organization);
  }
  args.push("--yes");

  await runCoderChecked(
    args,
    { env },
    `Creating Coder workspace ${workspaceName}`,
  );
};

const closeCoderWorkspace = async (
  env: NodeJS.ProcessEnv,
  workspaceRef: string,
  onClose: CoderOnClose,
): Promise<void> => {
  if (onClose === "leave") return;
  const command = onClose === "delete" ? "delete" : "stop";
  await runCoderChecked(
    [command, workspaceRef, "--yes"],
    { env },
    `${command === "delete" ? "Deleting" : "Stopping"} Coder workspace ${workspaceRef}`,
  );
};

const cleanupCreatedWorkspace = async (
  env: NodeJS.ProcessEnv,
  workspaceRef: string,
  onClose: CoderOnClose,
  originalError: unknown,
): Promise<never> => {
  try {
    await closeCoderWorkspace(env, workspaceRef, onClose);
  } catch (cleanupError) {
    const originalMessage =
      originalError instanceof Error
        ? originalError.message
        : String(originalError);
    const cleanupMessage =
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    throw new Error(
      `${originalMessage}\nAdditionally, cleanup of Coder workspace ${workspaceRef} failed: ${cleanupMessage}`,
    );
  }
  throw originalError;
};

const waitForProcess = (
  proc: ReturnType<typeof spawn>,
  label: string,
  options?: { readonly collectStdout?: boolean },
): Promise<CoderCommandResult> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  if (options?.collectStdout) {
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });
  }

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });

  return new Promise((resolve, reject) => {
    proc.on("error", (error: Error) => {
      reject(new Error(`${label} failed to start: ${error.message}`));
    });
    proc.on("close", (code: number | null) => {
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 0,
      });
    });
  });
};

const throwIfPipelineFailed = (
  description: string,
  parts: ReadonlyArray<{
    readonly label: string;
    readonly result: CoderCommandResult;
  }>,
  pipeError?: unknown,
): void => {
  const failures = parts.filter((part) => part.result.exitCode !== 0);
  if (!pipeError && failures.length === 0) return;

  const details: string[] = [];
  if (pipeError) {
    details.push(
      `pipe error: ${pipeError instanceof Error ? pipeError.message : String(pipeError)}`,
    );
  }
  for (const failure of failures) {
    details.push(
      `${failure.label} exited ${failure.result.exitCode}: ${failure.result.stderr}${failure.result.stdout}`,
    );
  }
  throw new Error(`${description} failed\n${details.join("\n")}`);
};

const copyDirectoryIn = async (
  env: NodeJS.ProcessEnv,
  sshRef: string,
  sshHostname: string,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  await ensureRemoteDirectory(env, sshRef, sandboxPath);

  const tar = spawn("tar", ["czf", "-", "-C", hostPath, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const remote = spawn(
    "ssh",
    buildOpenSshArgs(sshHostname, `tar xzf - -C ${shellQuote(sandboxPath)}`),
    { env, stdio: ["pipe", "ignore", "pipe"] },
  );

  const pipeResult = pipeline(tar.stdout!, remote.stdin!).catch(
    (error: unknown) => error,
  );
  const [tarResult, remoteResult, pipeOutcome] = await Promise.all([
    waitForProcess(tar, "tar"),
    waitForProcess(remote, "coder ssh tar"),
    pipeResult,
  ]);

  throwIfPipelineFailed(
    "copyIn directory",
    [
      { label: "tar", result: tarResult },
      { label: "coder ssh tar", result: remoteResult },
    ],
    pipeOutcome instanceof Error ? pipeOutcome : undefined,
  );
};

const copyFileIn = async (
  env: NodeJS.ProcessEnv,
  sshRef: string,
  sshHostname: string,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  await ensureRemoteDirectory(env, sshRef, posix.dirname(sandboxPath));

  const remote = spawn(
    "ssh",
    buildOpenSshArgs(sshHostname, `cat > ${shellQuote(sandboxPath)}`),
    { env, stdio: ["pipe", "ignore", "pipe"] },
  );

  const pipeResult = pipeline(createReadStream(hostPath), remote.stdin!).catch(
    (error: unknown) => error,
  );
  const [processResult, pipeOutcome] = await Promise.all([
    waitForProcess(remote, "coder ssh cat"),
    pipeResult,
  ]);

  throwIfPipelineFailed(
    "copyIn file",
    [{ label: "coder ssh cat", result: processResult }],
    pipeOutcome instanceof Error ? pipeOutcome : undefined,
  );
};

const copyFileOut = async (
  env: NodeJS.ProcessEnv,
  sshHostname: string,
  sandboxPath: string,
  hostPath: string,
): Promise<void> => {
  await mkdir(dirname(hostPath), { recursive: true });

  const remote = spawn(
    "ssh",
    buildOpenSshArgs(sshHostname, `cat < ${shellQuote(sandboxPath)}`),
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const pipeResult = pipeline(
    remote.stdout!,
    createWriteStream(hostPath),
  ).catch((error: unknown) => error);
  const [processResult, pipeOutcome] = await Promise.all([
    waitForProcess(remote, "coder ssh cat"),
    pipeResult,
  ]);

  throwIfPipelineFailed(
    "copyFileOut",
    [{ label: "coder ssh cat", result: processResult }],
    pipeOutcome instanceof Error ? pipeOutcome : undefined,
  );
};

const createHandle = (
  env: NodeJS.ProcessEnv,
  sandboxEnv: Record<string, string>,
  resolved: ResolvedCoderWorkspace,
  onClose: CoderOnClose,
): IsolatedSandboxHandle => ({
  worktreePath: resolved.worktreePath,

  exec: (
    command: string,
    opts?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ): Promise<ExecResult> => {
    assertNonEmptyString(command, "Coder exec command");
    const cwd = opts?.cwd ?? resolved.worktreePath;
    const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
    const remoteShellArg = `cd ${shellQuote(cwd)} && ${effectiveCommand}`;
    const onStdoutLine = opts?.onLine;

    // Stdin-bearing exec needs OpenSSH for EOF propagation; see runChildProcess.
    if (opts?.stdin !== undefined) {
      const envPrefix = buildEnvPrefix(sandboxEnv);
      return runOpenSsh(
        buildOpenSshArgs(
          resolved.sshHostname,
          `${envPrefix}sh -c ${shellQuote(remoteShellArg)}`,
        ),
        { env, stdin: opts.stdin, onStdoutLine },
      );
    }

    return runCoder(
      buildSshArgs(resolved.sshRef, sandboxEnv, remoteShell(remoteShellArg)),
      { env, onStdoutLine },
    );
  },

  interactiveExec: (
    args: string[],
    opts: InteractiveExecOptions,
  ): Promise<{ exitCode: number }> => {
    if (args.length === 0) {
      throw new Error("interactiveExec requires at least one argument");
    }
    const cwd = opts.cwd ?? resolved.worktreePath;
    const remoteArgs = [
      `cd ${shellQuote(cwd)} && exec ${args.map((arg) => shellQuote(arg)).join(" ")}`,
    ];

    return new Promise((resolve, reject) => {
      // Forwarding the host TTY descriptors lets `coder ssh` auto-detect a TTY;
      // there is no explicit force-PTY flag.
      const proc = spawn(
        "coder",
        buildSshArgs(resolved.sshRef, sandboxEnv, remoteArgs),
        {
          env,
          stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
        },
      );

      proc.on("error", (error: Error) => {
        reject(new Error(`coder ssh failed: ${error.message}`));
      });

      proc.on("close", (code: number | null) => {
        resolve({ exitCode: code ?? 0 });
      });
    });
  },

  copyIn: async (hostPath: string, sandboxPath: string): Promise<void> => {
    assertNonEmptyString(hostPath, "copyIn hostPath");
    assertRemoteAbsolutePath(sandboxPath, "copyIn sandboxPath");

    const info = await stat(hostPath);
    if (info.isDirectory()) {
      await copyDirectoryIn(
        env,
        resolved.sshRef,
        resolved.sshHostname,
        hostPath,
        sandboxPath,
      );
    } else {
      await copyFileIn(
        env,
        resolved.sshRef,
        resolved.sshHostname,
        hostPath,
        sandboxPath,
      );
    }
  },

  copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> => {
    assertRemoteAbsolutePath(sandboxPath, "copyFileOut sandboxPath");
    assertNonEmptyString(hostPath, "copyFileOut hostPath");
    return copyFileOut(env, resolved.sshHostname, sandboxPath, hostPath);
  },

  close: (): Promise<void> =>
    closeCoderWorkspace(env, resolved.workspaceRef, onClose),
});

export const coder = (options: CoderOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "coder",
    env: options.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const env = coderEnv(options);
      const sandboxEnv = createOptions.env;
      await preflightCoder(env);

      let cleanupRef: string | undefined;
      if (isCreateOptions(options)) {
        const workspaceName = options.workspaceName ?? createWorkspaceName();
        cleanupRef = workspaceName;
        await createCoderWorkspace(env, options, workspaceName);
        const createOptionsWithName = { ...options, workspaceName };
        try {
          const resolved = await resolveCoderWorkspace(
            env,
            createOptionsWithName,
          );
          cleanupRef = resolved.workspaceRef;
          return createHandle(env, sandboxEnv, resolved, options.onClose);
        } catch (error) {
          return cleanupCreatedWorkspace(
            env,
            cleanupRef,
            options.onClose,
            error,
          );
        }
      }

      const resolved = await resolveCoderWorkspace(env, options);
      return createHandle(env, sandboxEnv, resolved, options.onClose);
    },
  });
