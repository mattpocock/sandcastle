import { posix } from "node:path";
import {
  Array as Arr,
  Chunk,
  Effect,
  Either,
  Option,
  pipe,
  Schema,
  Stream,
} from "effect";
import type { FollowOptions } from "./Sandbox.js";
import type { ProviderSandbox } from "./SandboxProvider.js";
import { SandboxUnavailableError } from "./SandboxUnavailableError.js";
import type { RecordedEvent } from "./SessionRecord.js";
import { readSupervisorStatus } from "./sandboxStatus.js";
import type { SupervisorStatus } from "./supervisorStatusSchema.js";
import { eventsFile } from "./supervisorStatusSchema.js";
import { RecordedEvent as RecordedEventSchema } from "./sessionRecordSchema.js";

// The host's side of `follow()`: polls a session's events file through the
// provider's file reads, from where the last read stopped, until the status
// file says the session has ended. Needs no live supervisor (ADR 0031).

/** How long to wait between reads while the session runs. */
const POLL_MS = 500;

const EventJson = Schema.parseJson(RecordedEventSchema);

const decodeEvent = Schema.decodeUnknownEither(EventJson);

type Work = SupervisorStatus["running"][number];

/** Where a follow has got to. */
interface Cursor {
  /** The session, once picked from the first status read. */
  readonly session?: Work;
  /** How much of the events file has been read, up to its last complete line. */
  readonly offset: number;
  /** Whether a read has happened yet: later ones wait a poll first. */
  readonly polled: boolean;
}

/**
 * The session to follow: the latest by that name, running first, or with no
 * name the only one the sandbox has run.
 */
const pick = (status: SupervisorStatus, name: string | undefined): Work => {
  const all: readonly Work[] = [...status.ended, ...status.running];
  const names = Arr.dedupe(all.map((work) => work.name));
  const wanted = name ?? (names.length === 1 ? names[0] : undefined);
  const found = pipe(
    all,
    Arr.findLast((work) => work.name === wanted),
  );
  if (Option.isSome(found)) {
    return found.value;
  }
  const known = names.length === 0 ? "none" : names.join(", ");
  throw new TypeError(
    name === undefined
      ? `follow: name the session to follow (sessions: ${known})`
      : `follow: no session named "${name}" (sessions: ${known})`,
  );
};

/** The complete lines after `offset`, decoded, and where the next read starts. */
const newEvents = (
  text: string,
  offset: number,
): { readonly events: RecordedEvent[]; readonly offset: number } => {
  const end = text.lastIndexOf("\n") + 1;
  if (end <= offset) {
    return { events: [], offset };
  }
  const events = text
    .slice(offset, end)
    .split("\n")
    .flatMap((line) => {
      const decoded = decodeEvent(line);
      return Either.isRight(decoded) ? [decoded.right] : [];
    });
  return { events, offset: end };
};

/** One read: the status file, then the events file past the cursor. */
/** What every read of one follow shares. */
interface Followed {
  readonly sandbox: ProviderSandbox;
  readonly directory: string;
  readonly options: FollowOptions;
}

const step = ({ sandbox, directory, options }: Followed, cursor: Cursor) =>
  Effect.gen(function* () {
    if (cursor.polled) {
      yield* Effect.sleep(POLL_MS);
    }
    // A provider's own failure rejects the follow as it is.
    const status = yield* Effect.promise(async () =>
      readSupervisorStatus(sandbox, directory),
    );
    if (status === undefined) {
      return yield* Effect.fail(
        new SandboxUnavailableError({
          message: `Sandbox ${sandbox.sandboxId} has ended: its session supervisor's files are gone.`,
          sandboxId: sandbox.sandboxId,
        }),
      );
    }
    const session =
      cursor.session ??
      (yield* Effect.sync(() => pick(status, options.session)));
    // Read before the events file: once it says ended, the file is complete.
    const over =
      status.supervisor === "exited" ||
      status.ended.some((work) => work.id === session.id);
    const text = yield* Effect.promise(async () =>
      sandbox.readTextFile({
        path: posix.join(directory, eventsFile(session.id)),
      }),
    );
    const read = newEvents(text ?? "", cursor.offset);
    const next: Cursor = { session, offset: read.offset, polled: true };
    return [
      Chunk.fromIterable(read.events),
      over ? Option.none() : Option.some(next),
    ] as const;
  });

/** `follow()` for a sandbox whose supervisor lives in `directory`. */
export const followSession = (
  sandbox: ProviderSandbox,
  directory: string,
  options: FollowOptions = {},
): AsyncIterable<RecordedEvent> => {
  const { from = 0 } = options;
  const start: Cursor = { offset: 0, polled: false };
  const events =
    Number.isInteger(from) && from >= 0
      ? Stream.paginateChunkEffect(start, (cursor) =>
          step({ sandbox, directory, options }, cursor),
        ).pipe(Stream.drop(from))
      : Stream.die(
          new RangeError(
            `follow: from must be a whole number, 0 or more, got ${from}`,
          ),
        );
  return Stream.toAsyncIterable(events);
};
