import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Effect, Either, Schema } from "effect";
import { shellEscape } from "../AgentProvider.js";
import { supervisorBundle } from "./supervisorBundle.js";
import type { Reply, Request } from "./supervisorProtocol.js";
import { ReplyJson } from "./supervisorProtocol.js";
import type { DetachCapability, ProviderSandbox } from "./SandboxProvider.js";

type SpawnDetached = (
  sandbox: ProviderSandbox,
  options: Parameters<DetachCapability["spawnDetached"]>[1],
) => Promise<void>;

// The host's side of the session supervisor. createSandbox copies the bundle
// in and starts it; every request after that is a file written into its
// directory plus a short exec of its client, whose stdout carries the
// replies. That needs only exec with streamed stdout and file writes from a
// provider, never stdin or per-command env.

/** A started supervisor, as the host talks to it. */
export interface SupervisorLink {
  /** Sends one request; `onReply` gets each reply. Resolves once the supervisor has answered in full. */
  readonly call: (
    request: Request,
    onReply: (reply: Reply) => void,
    abortSignal?: AbortSignal,
  ) => Promise<void>;
  /** Stops every session and the supervisor. Never rejects. */
  readonly shutdown: () => Promise<void>;
}

const decodeReply = Schema.decodeUnknownEither(ReplyJson);
const SHUTDOWN_TIMEOUT = "10 seconds";

/** The sandbox user's home, checking Node is there to run the supervisor. */
const sandboxHome = async (sandbox: ProviderSandbox): Promise<string> => {
  const probe = await sandbox.exec({
    command: String.raw`printf "%s\n" "$HOME" && command -v node`,
  });
  const home = probe.stdout.split("\n")[0] ?? "";
  if (probe.exitCode !== 0 || home === "") {
    throw new Error(
      "the sandbox has no `node` on its PATH: the session supervisor needs Node.js",
    );
  }
  return home;
};

const callOn =
  (sandbox: ProviderSandbox, directory: string): SupervisorLink["call"] =>
  async (request, onReply, abortSignal) => {
    const file = `requests/${randomUUID()}.json`;
    await sandbox.writeTextFile({
      path: posix.join(directory, file),
      content: JSON.stringify(request),
    });
    const result = await sandbox.exec({
      command: `node supervisor.mjs call ${shellEscape(file)}`,
      workingDirectory: directory,
      onLine: (line) => {
        const reply = decodeReply(line);
        if (Either.isRight(reply)) {
          onReply(reply.right);
        }
      },
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `the session supervisor didn't answer (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  };

/** Copies the supervisor into the sandbox, starts it and waits until it answers. */
export const startSupervisor = async (
  sandbox: ProviderSandbox,
  spawnDetached: SpawnDetached | undefined,
): Promise<SupervisorLink> => {
  const home = await sandboxHome(sandbox);
  const directory = posix.join(
    home,
    ".sandcastle",
    "supervisor",
    sandbox.sandboxId.replaceAll(/[^A-Za-z0-9._-]/gu, "_"),
  );
  await sandbox.writeTextFile({
    path: posix.join(directory, "supervisor.mjs"),
    content: await supervisorBundle(),
  });
  const command = `cd ${shellEscape(directory)} && exec node supervisor.mjs daemon >> supervisor.log 2>&1`;
  if (spawnDetached === undefined) {
    // Held for the sandbox's life; closing the sandbox ends it.
    void sandbox.exec({ command }).catch(() => undefined);
  } else {
    // Detached from the start, so letting go of the handle never drops it.
    await spawnDetached(sandbox, { command });
  }
  const call = callOn(sandbox, directory);
  await call({ type: "hello" }, () => undefined);
  return {
    call,
    shutdown: async () =>
      Effect.runPromise(
        Effect.tryPromise(async () =>
          call({ type: "shutdown" }, () => undefined),
        ).pipe(Effect.timeout(SHUTDOWN_TIMEOUT), Effect.ignore),
      ),
  };
};
