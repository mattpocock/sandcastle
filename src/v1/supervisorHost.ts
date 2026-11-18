import { randomUUID } from "node:crypto";
import { Effect, Either, Schema } from "effect";
import { shellEscape } from "../AgentProvider.js";
import { joinInSandbox } from "./sandboxPath.js";
import { supervisorBundle } from "./supervisorBundle.js";
import type { Reply, Request } from "./supervisorProtocol.js";
import { ReplyJson } from "./supervisorProtocol.js";
import { outputTail } from "./execFailure.js";
import type { DetachCapability, ProviderSandbox } from "./SandboxProvider.js";

/** Starts the supervisor so it outlives the host's hold on the sandbox. */
export type SpawnDetached = (
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
  /** The supervisor's public key, from its hello: finish-report secrets are sealed to it. */
  readonly publicKey: () => Promise<string>;
  /** Its directory in the sandbox, where it keeps its status, reports and log. */
  readonly directory: string;
}

const decodeReply = Schema.decodeUnknownEither(ReplyJson);
const SHUTDOWN_TIMEOUT = "10 seconds";

/**
 * Prints the sandbox user's home with Node, so a sandbox with no `node`
 * fails it. A simple command, so it runs unchanged where there's no `sh`.
 */
export const HOME_PROBE = `node -p 'require("node:os").homedir()'`;

/** The sandbox user's home, checking Node is there to run the supervisor. */
const sandboxHome = async (sandbox: ProviderSandbox): Promise<string> => {
  const probe = await sandbox.exec({ command: HOME_PROBE });
  const home = probe.stdout.trim();
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
      path: joinInSandbox(directory, file),
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
        `the session supervisor didn't answer (exit ${result.exitCode}): ${outputTail(result.stderr)}`,
      );
    }
  };

/** The supervisor's directory in the sandbox, checking Node is there to run it. */
export const supervisorDirectory = async (
  sandbox: ProviderSandbox,
): Promise<string> =>
  joinInSandbox(
    await sandboxHome(sandbox),
    ".sandcastle",
    "supervisor",
    sandbox.sandboxId.replaceAll(/[^A-Za-z0-9._-]/gu, "_"),
  );

/** A link to the supervisor running in `directory`, once it has said hello. */
export const linkTo = async (
  sandbox: ProviderSandbox,
  directory: string,
): Promise<SupervisorLink> => {
  const call = callOn(sandbox, directory);
  let publicKey = "";
  await call({ type: "hello" }, (reply) => {
    if (reply.type === "hello") {
      ({ publicKey } = reply);
    }
  });
  if (publicKey === "") {
    throw new Error("the session supervisor didn't say hello");
  }
  return {
    call,
    publicKey: async () => publicKey,
    directory,
    shutdown: async () =>
      Effect.runPromise(
        Effect.tryPromise(async () =>
          call({ type: "shutdown" }, () => undefined),
        ).pipe(Effect.timeout(SHUTDOWN_TIMEOUT), Effect.ignore),
      ),
  };
};

/** Copies the supervisor into the sandbox, starts it and waits until it answers. */
export const startSupervisor = async (
  sandbox: ProviderSandbox,
  spawnDetached: SpawnDetached | undefined,
): Promise<SupervisorLink> => {
  const directory = await supervisorDirectory(sandbox);
  await sandbox.writeTextFile({
    path: joinInSandbox(directory, "supervisor.mjs"),
    content: await supervisorBundle(),
  });
  // A simple command, run in its directory: it opens supervisor.log itself.
  const start = {
    command: "node supervisor.mjs daemon",
    workingDirectory: directory,
  };
  if (spawnDetached === undefined) {
    // Held for the sandbox's life; closing the sandbox ends it.
    void sandbox.exec(start).catch(() => undefined);
  } else {
    // Detached from the start, so letting go of the handle never drops it.
    await spawnDetached(sandbox, start);
  }
  return linkTo(sandbox, directory);
};
