import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DateTime } from "effect";
import { shellEscape } from "../../AgentProvider.js";
import type { ProviderExecOptions } from "../SandboxProvider.js";
import type { SpritesExecContext } from "./spritesExec.js";
import { discard, prepare } from "./spritesExec.js";
import { connectionError } from "./spritesStream.js";

// Work that outlives the host's hold on a sprite. A sprite pauses after
// about 30 seconds without a connection unless a Task holds it, so the
// command runs inside a small keeper: it takes a Task on the sprite's own API
// socket, renews it while the command runs, and releases it when the command
// ends. If the keeper dies, the Task expires by itself within its lease.
// The exec carries on after the host disconnects for as long as the sandbox
// has left, through `maxRunAfterDisconnect`.

/** The Task API, inside the sprite. */
const TASKS = "--unix-socket /.sprite/api.sock http://sprite/v1/tasks";
/** How long one Task lease lasts. Sprites caps it at 1 hour. */
const LEASE = "300s";
/** How often the keeper renews the lease: well inside it. */
const RENEW_SECONDS = 60;
/** The line the keeper prints once it holds the Task and is starting the command. */
export const STARTED_MARKER = "sandcastle-detached-started";

/**
 * `script`, wrapped in the keeper. The command's own output goes nowhere:
 * nobody is reading the exec once the host has let go, so a command that
 * wants a log redirects to one.
 */
export const keeperScript = (task: string, script: string): string =>
  [
    `command -v curl >/dev/null || { echo "curl is needed to keep the sprite awake" >&2; exit 127; }`,
    `task=${shellEscape(task)}`,
    `api() { curl -s -o /dev/null -H 'Content-Type: application/json' "$@"; }`,
    `hold() { api -X PUT -d '{"expire":"${LEASE}"}' ${TASKS}/"$task"; }`,
    `release() { kill "$renewer" 2>/dev/null; api -X DELETE ${TASKS}/"$task"; }`,
    "hold",
    `(while sleep ${RENEW_SECONDS}; do hold; done) </dev/null >/dev/null 2>&1 &`,
    "renewer=$!",
    "trap 'release; exit 143' HUP INT TERM",
    `echo ${STARTED_MARKER}`,
    `(\n${script}\n) </dev/null >/dev/null 2>&1`,
    "code=$?",
    "release",
    'exit "$code"',
  ].join("\n");

/** Whole seconds from now until `killTime`, at least one. */
const secondsUntil = (killTime: Date): number =>
  Math.max(
    1,
    Math.ceil((killTime.getTime() - DateTime.unsafeNow().epochMillis) / 1000),
  );

type Exec = ReturnType<SpritesExecContext["sprite"]["spawn"]>;

/** Whether stdout carried the keeper's marker before it ended. */
const marked = async (proc: Exec): Promise<boolean> => {
  let stdout = "";
  for await (const chunk of proc.stdout) {
    stdout += String(chunk);
    if (stdout.includes(STARTED_MARKER)) {
      return true;
    }
  }
  return false;
};

/** Resolves once the keeper says it has started the command; rejects if it ends first. */
const started = async (proc: Exec): Promise<void> => {
  const stderr: string[] = [];
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });
  // `once` rejects if the exec emits "error" (a failed connection) first.
  const outcome = await Promise.race([
    marked(proc),
    once(proc, "exit").then(() => false),
  ]).catch((error: unknown) => {
    throw connectionError(error);
  });
  if (!outcome) {
    throw new Error(
      `sprites: the detached command ended before it started: ${stderr.join("").trim()}`,
    );
  }
};

/**
 * Starts a command in the keeper and lets go of it once it has started. It
 * keeps running, and keeps the sprite awake, until it ends or `killTime`.
 */
export const spawnInSprite = async (
  context: SpritesExecContext,
  killTime: Date,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
): Promise<void> => {
  const { script, folder } = await prepare(context, options);
  const task = `sandcastle-${randomUUID()}`;
  const proc = context.sprite.spawn("sh", ["-c", keeperScript(task, script)], {
    maxRunAfterDisconnect: `${secondsUntil(killTime)}s`,
  });
  proc.on("error", () => undefined);
  proc.once("spawn", () => {
    proc.stdin.end();
  });
  try {
    await started(proc);
  } catch (error) {
    // It never started, so it never removed its env file. Once it has
    // started it removes it itself: deleting it here would race it.
    await discard(context.sprite, folder);
    throw error;
  } finally {
    proc.close();
  }
};
