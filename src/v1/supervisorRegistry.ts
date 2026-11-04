import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { shellEscape } from "../AgentProvider.js";
import { agentFromDescriptor } from "./agentFromDescriptor.js";
import type { ReplayFile } from "./fakeAgentReplay.js";
import type { CarriedSession } from "./supervisorDetach.js";
import { carryOn } from "./supervisorDetach.js";
import type {
  DetachRequest,
  FinishReportDelivery,
  Reply,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";
import type { RecordSecrets } from "./supervisorSession.js";
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

/** Where the registry records its work for `status()`: each change resolves once it's on disk. */
export interface WorkBoard {
  readonly started: (id: string, request: SessionRequest) => Promise<void>;
  readonly forget: (id: string) => Promise<void>;
  readonly finished: (
    id: string,
    request: SessionRequest,
    outcome: SessionOutcome,
  ) => Promise<void>;
  readonly detached: (request: DetachRequest) => Promise<void>;
  readonly delivery: (state: FinishReportDelivery) => Promise<void>;
}

/** One session, from its start on the board to its `ended` reply. */
const runSession = (options: {
  readonly request: SessionRequest;
  readonly secrets: RecordSecrets;
  readonly send: (reply: Reply) => void;
  readonly running: Map<string, CarriedSession>;
  readonly board: WorkBoard;
  readonly detachId: () => string | undefined;
}): Effect.Effect<void> => {
  const { request, send, running, board } = options;
  return Effect.gen(function* () {
    yield* Effect.promise(async () => board.started(request.id, request));
    const command = yield* commandFor(request);
    const log = createWriteStream(path.join("sessions", `${request.id}.log`));
    const session = yield* startSession({
      request,
      agent: agentFromDescriptor(request.agent),
      command,
      log,
      emit: send,
      secrets: options.secrets,
      detachId: options.detachId,
    });
    running.set(request.id, { request, session });
    const outcome = yield* session.outcome;
    running.delete(request.id);
    yield* Effect.promise(async () =>
      board.finished(request.id, request, outcome),
    );
    log.end();
    send({ type: "ended", outcome });
  }).pipe(
    Effect.catchAllCause(() =>
      Effect.promise(async () => board.forget(request.id)).pipe(
        Effect.andThen(() => {
          send({ type: "error", message: "the session could not be started" });
        }),
      ),
    ),
  );
};

/** The sessions the supervisor is running. */
export class SessionRegistry {
  private readonly running = new Map<string, CarriedSession>();
  private detachId: string | undefined;

  private readonly board: WorkBoard;

  /** `board` is told whenever the work changes, for `status()`. */
  constructor(board: WorkBoard) {
    this.board = board;
  }

  /**
   * Starts a session, sending its replies; calls `done` once it has ended.
   * `secrets` are its record's upload URL and webhook secret, opened.
   */
  start({
    request,
    secrets,
    send,
    done,
  }: {
    readonly request: SessionRequest;
    readonly secrets: RecordSecrets;
    readonly send: (reply: Reply) => void;
    readonly done: () => void;
  }): void {
    if (this.detachId !== undefined) {
      // Only work spawned before a detach carries on.
      send({ type: "error", message: "the sandbox has been detached from" });
      done();
      return;
    }
    const program = runSession({
      request,
      secrets,
      send,
      running: this.running,
      board: this.board,
      detachId: () => this.detachId,
    }).pipe(Effect.ensuring(Effect.sync(done)));
    Effect.runFork(program);
  }

  /** Stops a session and waits for it to end. Unknown ids are fine. */
  async kill(id: string): Promise<void> {
    const session = this.running.get(id)?.session;
    if (session !== undefined) {
      await Effect.runPromise(
        Effect.andThen(session.kill("aborted"), session.outcome),
      );
    }
  }

  /**
   * Carries every running session on past a detach; `finished` is called once
   * the finish report is written and delivered. Returns the sessions carried
   * on: none, and nothing changes, when none is running or it has already
   * been detached.
   */
  async detach(
    request: DetachRequest,
    secret: string | undefined,
    finished: () => void,
  ): Promise<readonly { readonly name: string; readonly agent: string }[]> {
    const carried = [...this.running.values()];
    if (this.detachId !== undefined || carried.length === 0) {
      return [];
    }
    this.detachId = request.detachId;
    const { board } = this;
    const recorded = board.detached(request);
    carryOn({
      carried,
      request,
      secret,
      finished,
      delivery: async (state) => board.delivery(state),
    });
    await recorded;
    return carried.map(({ request: session }) => ({
      name: session.name,
      agent: session.agent.id,
    }));
  }

  /** Stops every session and waits for them to end. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.running.keys()].map(async (id) => this.kill(id)),
    );
  }
}
