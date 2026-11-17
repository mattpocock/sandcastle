/**
 * Daytona isolated sandbox provider.
 *
 * Creates ephemeral Daytona sandboxes via `@daytona/sdk`.
 * Requires `@daytona/sdk` as a peer dependency.
 */

import { createIsolatedSandboxProvider } from "../SandboxProvider.js";
import type {
  ExecResult,
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { copyInToSandbox, createWorkspaceFolder } from "./daytonaFiles.js";
import {
  prepareCommand,
  probeSessionShell,
  streamSessionLogs,
} from "./daytonaSession.js";
import type {
  DaytonaExecContext,
  DaytonaExecOptions,
  SessionCommand,
} from "./daytonaSession.js";

import type {
  Daytona as DaytonaClient,
  DaytonaConfig,
  Sandbox as DaytonaSandbox,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
} from "@daytona/sdk";

/** Options for the Daytona sandbox provider. */
export interface DaytonaOptions {
  /**
   * Daytona API key for authentication.
   * Falls back to the `DAYTONA_API_KEY` environment variable if not provided.
   */
  readonly apiKey?: string;

  /**
   * Daytona API URL.
   * Falls back to the `DAYTONA_API_URL` environment variable if not provided.
   */
  readonly apiUrl?: string;

  /**
   * Target environment for sandboxes.
   * Falls back to the `DAYTONA_TARGET` environment variable if not provided.
   */
  readonly target?: string;

  /**
   * Options passed through to the Daytona SDK when creating a sandbox.
   * Supports both image-based and snapshot-based creation.
   */
  readonly create?:
    | CreateSandboxFromImageParams
    | CreateSandboxFromSnapshotParams;

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

/** How often a streamed `exec` checks that its session shell is still alive. */
const SESSION_WATCH_INTERVAL_MS = 15_000;

/** The Daytona client config: only the connection options that are set. */
const toDaytonaConfig = (options?: DaytonaOptions): DaytonaConfig => {
  const { apiKey, apiUrl, target } = options ?? {};
  const config: DaytonaConfig = {};
  if (apiKey !== undefined && apiKey !== "") {
    config.apiKey = apiKey;
  }
  if (apiUrl !== undefined && apiUrl !== "") {
    config.apiUrl = apiUrl;
  }
  if (target !== undefined && target !== "") {
    config.target = target;
  }
  return config;
};

/**
 * Watches a session's shell: if it dies (killed, say) the log stream would
 * wait forever, so once it is gone `gone` settles: it fails if the command
 * recorded no exit code. A missing PID file counts as alive, so it can never
 * fail a command. Call `stop` once the race is over. An unexpected throw
 * while checking rejects `gone` instead of escaping as an unhandled
 * rejection from the timer.
 */
const watchSessionShell = (
  sandbox: DaytonaSandbox,
  session: SessionCommand,
  command: string,
): { readonly gone: Promise<void>; readonly stop: () => void } => {
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  let watching = true;
  const gone = new Promise<void>((resolve, reject) => {
    const scheduleCheck = () => {
      watchTimer = setTimeout(() => {
        check().catch(reject);
      }, SESSION_WATCH_INTERVAL_MS);
    };
    const check = async () => {
      const state = await probeSessionShell(sandbox, session);
      if (!watching) {
        return;
      }
      if (state === "alive") {
        scheduleCheck();
        return;
      }
      if (state === "exited") {
        resolve();
        return;
      }
      reject(
        new Error(
          `Daytona session shell exited before the command finished, so its exit code is unknown: ${command}`,
        ),
      );
    };
    scheduleCheck();
  });
  return {
    gone,
    stop: () => {
      watching = false;
      clearTimeout(watchTimer);
    },
  };
};

/**
 * Runs `command` in a fresh session, streaming its stdout to `onLine`.
 *
 * A session runs its commands in one long-lived shell, which records each
 * command's exit code once it returns. A command that ends that shell (a
 * top-level `exit`) never gets one, and its log stream never closes. So the
 * command runs in a subshell, where `exit` ends only the subshell. The
 * newline before `)` keeps a trailing comment from swallowing it. The
 * session shell's PID goes to a file, to check it is still alive.
 */
const execStreaming = async (
  context: DaytonaExecContext,
  {
    command,
    effectiveCommand,
    cwd,
  }: {
    readonly command: string;
    readonly effectiveCommand: string;
    readonly cwd: string;
  },
  onLine: (line: string) => void,
): Promise<ExecResult> => {
  const { sandbox } = context;
  const sessionId = `sandcastle-${crypto.randomUUID()}`;
  const pidPath = `/tmp/${sessionId}.pid`;
  await sandbox.process.createSession(sessionId);
  try {
    const { cmdId } = await sandbox.process.executeSessionCommand(sessionId, {
      command: `echo $$ > ${pidPath}; ( cd ${cwd} && ${effectiveCommand}\n)`,
      async: true,
    });
    const logs = streamSessionLogs(context, { sessionId, cmdId }, onLine);
    // Once the race below is lost, a late failure of the stream
    // must not surface as an unhandled rejection.
    logs.done.catch(() => undefined);
    const shell = watchSessionShell(
      sandbox,
      { sessionId, cmdId, pidPath },
      command,
    );
    try {
      await Promise.race([logs.done, shell.gone]);
    } finally {
      shell.stop();
    }
    logs.flush();
    const cmdInfo = await sandbox.process.getSessionCommand(sessionId, cmdId);
    return {
      stdout: logs.stdoutTail.toString(),
      stderr: logs.stderrTail.toString(),
      exitCode: cmdInfo.exitCode ?? 0,
    };
  } finally {
    await sandbox.process.deleteSession(sessionId).catch(() => undefined);
    await sandbox.process
      .executeCommand(`rm -f ${pidPath}`)
      .catch(() => undefined);
  }
};

/** A handle's `exec`: streamed through a session with `onLine`, else plain. */
const daytonaExec = async (
  context: DaytonaExecContext,
  command: string,
  opts?: DaytonaExecOptions,
): Promise<ExecResult> => {
  const { sandbox, worktreePath } = context;
  const effectiveCommand = await prepareCommand(sandbox, command, opts);
  const cwd = opts?.cwd ?? worktreePath;
  if (opts?.onLine) {
    return execStreaming(
      context,
      { command, effectiveCommand, cwd },
      opts.onLine,
    );
  }
  const response = await sandbox.process.executeCommand(effectiveCommand, cwd);
  // `executeCommand` merges stdout and stderr into `result` and has
  // no separate stderr. On failure, surface that output as stderr
  // too, so the error says why the command failed, not just its exit
  // code.
  return {
    stdout: response.result,
    stderr: response.exitCode === 0 ? "" : response.result,
    exitCode: response.exitCode,
  };
};

/**
 * Create a Daytona isolated sandbox provider.
 *
 * Sandboxes are ephemeral — each `create()` call spins up a new Daytona
 * sandbox and `close()` destroys it.
 *
 * @example
 * ```ts
 * import { daytona } from "@ai-hero/sandcastle/sandboxes/daytona";
 *
 * const provider = daytona({ apiKey: "dyt_my_key" });
 * ```
 */
export const daytona = (options?: DaytonaOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "daytona",
    env: options?.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
      const { Daytona } = await import("@daytona/sdk");

      const client: DaytonaClient = new Daytona(toDaytonaConfig(options));
      // Pass the resolved env (env resolver + provider + agent) to the
      // sandbox. Explicit `create.envVars` win, as the most specific source.
      const createParams = options?.create;
      const envVars = { ...createOptions.env, ...createParams?.envVars };
      // `client.create` is overloaded per params shape, so call the overload
      // that matches instead of passing the union.
      const sandbox =
        createParams !== undefined && "image" in createParams
          ? await client.create({ ...createParams, envVars })
          : await client.create({ ...createParams, envVars });

      const worktreePath = await createWorkspaceFolder(sandbox);

      const context = { sandbox, worktreePath, maxOutputTailChars };
      return {
        worktreePath,
        sandboxId: sandbox.id,
        exec: async (command: string, opts?: DaytonaExecOptions) =>
          daytonaExec(context, command, opts),
        copyIn: async (hostPath: string, sandboxPath: string) =>
          copyInToSandbox(sandbox, hostPath, sandboxPath),
        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          await sandbox.fs.downloadFile(sandboxPath, hostPath);
        },

        close: async (): Promise<void> => {
          await client.delete(sandbox);
        },
      };
    },
  });
