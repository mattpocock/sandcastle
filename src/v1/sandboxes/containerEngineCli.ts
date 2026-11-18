import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { BoundedTail, MAX_TAIL_CHARS } from "../../boundedTail.js";

// Running a container engine's CLI (`docker`, `podman`) on the host. Nothing
// here knows which engine it is: the engine is only the CLI's name and what
// to tell a user whose engine isn't running.

/** A container engine, as the engine-generic code sees it. */
export interface ContainerEngine {
  /** The CLI's name on PATH, and the provider's name: `docker`, `podman`. */
  readonly cli: string;
  /** What to tell a user whose CLI can't reach its engine, e.g. "Start Docker Desktop or the Docker daemon". */
  readonly startHint: string;
}

/** How one CLI call went. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How to run one CLI call. */
export interface CliCall {
  /** Written to the CLI's stdin, which is then closed. Without it, stdin is closed at once. */
  readonly stdin?: string;
  /** Called with each stdout line as it arrives; stdout is then kept as a bounded tail. */
  readonly onLine?: (line: string) => void;
  /** Called with each stderr chunk as it arrives. */
  readonly onStderr?: (chunk: string) => void;
  /** Kills the CLI. */
  readonly abortSignal?: AbortSignal;
}

/** The engine's message when its CLI can't reach the engine, from Docker's and Podman's own wording. */
const UNREACHABLE =
  /Cannot connect to the (?:Docker|Podman) daemon|Is the docker daemon running|error during connect|Cannot connect to Podman|unable to connect to Podman/iu;

/** An error for a CLI call that failed, saying what to do when the engine isn't there. */
export const cliError = (
  engine: ContainerEngine,
  what: string,
  result: CliResult,
): Error => {
  const said = result.stderr.trim() || `exit ${String(result.exitCode)}`;
  const hint = UNREACHABLE.test(said)
    ? ` \`${engine.cli}\` can't reach its engine. ${engine.startHint}, then try again.`
    : "";
  return new Error(`${engine.cli}: ${what} failed: ${said}${hint}`);
};

/** The error for a CLI that couldn't be started at all. */
const spawnError = (engine: ContainerEngine, error: Error): Error =>
  "code" in error && error.code === "ENOENT"
    ? new Error(
        `${engine.cli}: there's no \`${engine.cli}\` CLI on PATH. Install it and make sure \`${engine.cli}\` runs from a terminal.`,
        { cause: error },
      )
    : new Error(
        `${engine.cli}: couldn't run \`${engine.cli}\`: ${error.message}`,
        {
          cause: error,
        },
      );

/** Passes each whole line of a stream to `onLine` as it arrives, and a last unterminated one on `flush`. */
const lineSplitter = (onLine: ((line: string) => void) | undefined) => {
  let partial = "";
  return {
    push: (chunk: string) => {
      if (onLine === undefined) {
        return;
      }
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
    },
    flush: () => {
      if (partial !== "") {
        onLine?.(partial);
      }
    },
  };
};

/** Collects a CLI's output, passing stdout lines and stderr chunks on as they arrive. */
const collect = (
  proc: ChildProcessByStdio<Writable, Readable, Readable>,
  call: CliCall,
) => {
  const { onLine, onStderr } = call;
  // A streamed call keeps bounded tails; a buffered one (a file) keeps it all.
  const limit =
    onLine === undefined ? Number.POSITIVE_INFINITY : MAX_TAIL_CHARS;
  const stdout = new BoundedTail(limit, "");
  const stderr = new BoundedTail(limit, "");
  const lines = lineSplitter(onLine);
  proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout.push(chunk);
    lines.push(chunk);
  });
  proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr.push(chunk);
    onStderr?.(chunk);
  });
  return (code: unknown): CliResult => {
    lines.flush();
    return {
      exitCode: typeof code === "number" ? code : 1,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    };
  };
};

/** Runs `<engine> <args>` and resolves with how it went, whatever its exit code. */
export const runCli = async (
  engine: ContainerEngine,
  args: readonly string[],
  call: CliCall = {},
): Promise<CliResult> => {
  const proc = spawn(engine.cli, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed: Promise<unknown[]> = once(proc, "close");
  // A CLI that exits without reading its stdin closes the pipe early.
  proc.stdin.on("error", () => undefined).end(call.stdin ?? "");
  const result = collect(proc, call);
  const kill = () => {
    proc.kill();
  };
  call.abortSignal?.addEventListener("abort", kill, { once: true });
  try {
    const [code] = await closed;
    return result(code);
  } catch (error) {
    throw spawnError(
      engine,
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    call.abortSignal?.removeEventListener("abort", kill);
  }
};

/** Runs `<engine> <args>` and resolves its stdout; rejects saying `what` failed when it exits non-zero. */
export const runCliOrFail = async (
  engine: ContainerEngine,
  args: readonly string[],
  call: CliCall & { readonly what: string },
): Promise<string> => {
  const result = await runCli(engine, args, call);
  if (result.exitCode !== 0) {
    throw cliError(engine, call.what, result);
  }
  return result.stdout;
};
