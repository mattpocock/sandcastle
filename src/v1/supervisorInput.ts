import { DateTime, Deferred, Effect, Exit, Queue } from "effect";
import {
  acceptsInput,
  inputSignal,
  interruptLine,
  messageText,
  userLine,
} from "./agentInput.js";
import type { AgentProcess } from "./agentProcess.js";
import type { RecordedEvent } from "./SessionRecord.js";
import type {
  AgentDescriptor,
  InputRequest,
  Reply,
  SessionRequest,
} from "./supervisorProtocol.js";

// Inside the sandbox: messages for a running session's agent, written to its
// stdin (see agentInput.ts for the protocol). The supervisor counts the
// messages it writes after the prompt and the ones the agent has read; at the
// end of a turn with nothing left unread it closes stdin, so a session nobody
// talks to ends after its one turn, as it always has. The prompt is read by
// the end of the first turn whether or not the agent printed it back, so an
// agent that never prints messages back still ends after its one turn.

/** How long an interrupt may take to be acknowledged before the message goes anyway. */
const INTERRUPT_WAIT = "10 seconds";

/** A session's input, as the supervisor keeps it. */
export interface InputState {
  /** Whether the agent takes messages at all. */
  readonly accepts: boolean;
  /** Whether its stdin is still open for messages. */
  open: boolean;
  /** Messages written after the prompt. */
  written: number;
  /** Of those, the ones the agent has printed back as read. */
  read: number;
  /** Whether the prompt has been read: printed back, or a turn has ended. */
  promptRead: boolean;
  /** Interrupts written and not yet acknowledged, by request id. */
  readonly interrupts: Map<string, Deferred.Deferred<true>>;
  interruptCount: number;
  /** Done once stdin is closed for good. */
  readonly closed: Deferred.Deferred<true>;
}

/** The input state for a new session of this agent. */
export const inputState = (
  agent: AgentDescriptor["id"],
): Effect.Effect<InputState> => {
  const accepts = acceptsInput(agent);
  return Effect.map(Deferred.make<true>(), (closed) => ({
    accepts,
    open: accepts,
    written: 0,
    read: 0,
    promptRead: false,
    interrupts: new Map(),
    interruptCount: 0,
    closed,
  }));
};

/** Messages written to the agent that it hasn't read yet. */
export const unread = (state: InputState): number => state.written - state.read;

/** Stops taking messages: stdin is (or is about to be) closed. */
export const closeInput = (state: InputState): void => {
  state.open = false;
  Deferred.unsafeDone(state.closed, Exit.succeed(true));
};

/** Notes what one line of the agent's stdout says about its input. */
export const observeInput = (
  state: InputState,
  process: AgentProcess,
  line: string,
): void => {
  const signal = state.accepts ? inputSignal(line) : undefined;
  if (signal === undefined) {
    return;
  }
  if (signal.type === "read") {
    if (state.promptRead) {
      state.read += 1;
    }
    state.promptRead = true;
  } else if (signal.type === "turn-ended") {
    state.promptRead = true;
    if (state.open && unread(state) <= 0) {
      closeInput(state);
      process.endInput();
    }
  } else {
    const acknowledged = state.interrupts.get(signal.requestId);
    state.interrupts.delete(signal.requestId);
    if (acknowledged !== undefined) {
      Deferred.unsafeDone(acknowledged, Exit.succeed(true));
    }
  }
};

/** A running session, as a message for it needs it. */
export interface InputTarget {
  readonly state: InputState;
  readonly process: AgentProcess;
  readonly request: SessionRequest;
  /** Adds an event to the session's record and events file. */
  readonly record: (event: RecordedEvent) => void;
}

const refused = (
  reason: Extract<Reply, { type: "refused" }>["reason"],
  message: string,
): Reply => ({ type: "refused", reason, message });

const stoppedTakingInput = (name: string): Reply =>
  refused(
    "stopped-taking-input",
    `Session "${name}" has stopped taking input: its agent has finished its last turn, or the session has ended.`,
  );

/** Stops the agent's current turn; resolves once it says so, or stdin closes, or it doesn't in time. */
const interrupt = (target: InputTarget): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { state } = target;
    state.interruptCount += 1;
    const requestId = `sandcastle-interrupt-${state.interruptCount}`;
    const acknowledged = yield* Deferred.make<true>();
    state.interrupts.set(requestId, acknowledged);
    target.process.write(interruptLine(requestId));
    yield* Effect.raceFirst(
      Deferred.await(acknowledged),
      Deferred.await(state.closed),
    ).pipe(Effect.timeoutOption(INTERRUPT_WAIT));
  });

/** Writes a message to the agent, interrupting its turn first when asked. */
export const sendInput = (
  target: InputTarget,
  request: InputRequest,
): Effect.Effect<Reply> =>
  Effect.gen(function* () {
    const { state, process } = target;
    const { name } = target.request;
    if (!state.accepts) {
      return refused(
        "agent-takes-no-input",
        `Session "${name}" runs ${target.request.agent.id}, which takes no input while it runs: only claude-code does.`,
      );
    }
    if (!state.open) {
      return stoppedTakingInput(name);
    }
    // Counted before an interrupt goes out: the interrupted turn's end must
    // not close stdin before the message that follows it is written.
    state.written += 1;
    if (request.interrupt) {
      yield* interrupt(target);
    }
    // Checked again: the session may have ended while the interrupt was out.
    if (!state.open) {
      return stoppedTakingInput(name);
    }
    const at = DateTime.formatIso(DateTime.unsafeNow());
    process.write(userLine(messageText(request.text, request.from)));
    yield* Queue.offer(process.items, { _tag: "input" });
    target.record({
      type: "input",
      text: request.text,
      ...(request.from === undefined ? {} : { from: request.from }),
      interrupt: request.interrupt,
      at,
    });
    return {
      type: "accepted",
      name,
      at,
      interrupted: request.interrupt,
    };
  });

/** Hands `target`'s agent each message it's given. */
export const inputTo =
  (target: InputTarget) =>
  (request: InputRequest): Effect.Effect<Reply> =>
    sendInput(target, request);
