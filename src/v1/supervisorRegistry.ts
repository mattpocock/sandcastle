import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { shellEscape } from "../AgentProvider.js";
import { agentFromDescriptor } from "./agentFromDescriptor.js";
import type { ReplayFile } from "./fakeAgentReplay.js";
import type { Reply, SessionRequest } from "./supervisorProtocol.js";
import type { RunningSession } from "./supervisorSession.js";
import { startSession } from "./supervisorSession.js";

// The sessions the supervisor is running, by request id.

/**
 * The command that runs the session's agent: the agent's own, or for a fake
 * agent this bundle replaying its script with the real command line after it.
 */
const commandFor = (
  request: SessionRequest,
): Effect.Effect<(real: string) => string> => {
  const { replay } = request.agent;
  if (replay === undefined) {
    return Effect.succeed((real) => real);
  }
  const file = path.resolve("replays", `${request.id}.json`);
  const replayFile: ReplayFile = { format: request.agent.id, ...replay };
  const content = JSON.stringify(replayFile);
  const [node, bundle] = [process.execPath, process.argv[1] ?? ""];
  return Effect.promise(async () => writeFile(file, content)).pipe(
    Effect.as(
      (real: string) =>
        `${shellEscape(node)} ${shellEscape(bundle)} replay ${shellEscape(file)} ${real}`,
    ),
  );
};

/** The sessions the supervisor is running. */
export class SessionRegistry {
  private readonly running = new Map<string, RunningSession>();

  /** Starts a session, sending its replies; calls `done` once it has ended. */
  start(
    request: SessionRequest,
    send: (reply: Reply) => void,
    done: () => void,
  ): void {
    const { running } = this;
    const program = Effect.gen(function* () {
      const command = yield* commandFor(request);
      const log = createWriteStream(path.join("sessions", `${request.id}.log`));
      const session = yield* startSession({
        request,
        agent: agentFromDescriptor(request.agent),
        command,
        log,
        emit: send,
      });
      running.set(request.id, session);
      const outcome = yield* session.outcome;
      running.delete(request.id);
      log.end();
      send({ type: "ended", outcome });
    }).pipe(
      Effect.catchAllCause(() =>
        Effect.sync(() => {
          send({ type: "error", message: "the session could not be started" });
        }),
      ),
      Effect.ensuring(Effect.sync(done)),
    );
    Effect.runFork(program);
  }

  /** Stops a session and waits for it to end. Unknown ids are fine. */
  async kill(id: string): Promise<void> {
    const session = this.running.get(id);
    if (session !== undefined) {
      await Effect.runPromise(Effect.andThen(session.kill, session.outcome));
    }
  }

  /** Stops every session and waits for them to end. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.running.keys()].map(async (id) => this.kill(id)),
    );
  }
}
