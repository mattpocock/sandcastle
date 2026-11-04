import { FetchHttpClient } from "@effect/platform";
import { Clock, Config, DateTime, Effect, Schema } from "effect";
import type { DeliveryMethod } from "./httpDelivery.js";
import { deliver } from "./httpDelivery.js";
import { redactor } from "./redaction.js";
import type { RecordedEvent, SessionRecordPointer } from "./SessionRecord.js";
import { buildSessionRecord } from "./sessionRecordBuild.js";
import type { RecordRequest, RecordSecrets } from "./sessionRecordSchema.js";
import { SessionRecordSchema } from "./sessionRecordSchema.js";
import { claudeSessionText } from "./sessionUsage.js";
import type {
  Reply,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";
import { signingKey } from "./webhookSignature.js";

// Inside the sandbox, once a session has ended: builds its record, redacts
// it, and sends it to the sinks that run here (webhook and upload), and back
// to the host for its own (directory and function) while it's held. Runs
// before the session counts as ended, so a finish report always comes after
// the records it points to. A record that can't be sent never fails the
// session: the pointer says how each sink went.

/** How long a sink may keep retrying, at most: the finish report waits on it. */
const MAX_DELIVERY_MS = 60_000;

/** What the supervisor gathers about a session for its record while it runs. */
export interface Recording {
  readonly request: SessionRequest;
  /** The upload URL and webhook secret, opened from the request. */
  readonly secrets: RecordSecrets;
  /** The session's events, as they happen. */
  readonly events: readonly RecordedEvent[];
  readonly startedAt: string;
  /** The sandbox's kill time, on the supervisor's clock. */
  readonly killAtMs: number;
  /** The env the session ran with, on top of the supervisor's own. */
  readonly sessionEnv: Readonly<Record<string, string>>;
  /** The detach the session is carried on under, if any, asked when it ends. */
  readonly detachId: () => string | undefined;
  readonly emit: (reply: Reply) => void;
}

/** Nothing to read or send. */
const nothing: Effect.Effect<undefined> = Effect.sync(() => undefined);

const encodeRecord = Schema.encode(Schema.parseJson(SessionRecordSchema));

/** The value an env var had for the session: its own env first, then the supervisor's. */
const envValue = (
  name: string,
  sessionEnv: Readonly<Record<string, string>>,
): Effect.Effect<readonly [string, string]> => {
  const own = sessionEnv[name];
  if (own !== undefined) {
    return Effect.succeed([name, own]);
  }
  return Config.string(name).pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
    Effect.map((value): readonly [string, string] => [name, value]),
  );
};

/** The values the named env vars had for the session. */
const envValues = (
  names: readonly string[],
  sessionEnv: Readonly<Record<string, string>>,
): Effect.Effect<Record<string, string>> =>
  Effect.all(names.map((name) => envValue(name, sessionEnv))).pipe(
    Effect.map((entries) => Object.fromEntries(entries)),
  );

/** The agent's transcript, when it keeps one the supervisor can read. */
const nativeOf = (
  request: SessionRequest,
  outcome: SessionOutcome,
): Effect.Effect<
  { readonly fileName: string; readonly text: string } | undefined
> => {
  const { sessionId } = outcome;
  if (request.agent.id !== "claude-code" || sessionId === undefined) {
    return nothing;
  }
  return claudeSessionText(request.workingDirectory, sessionId).pipe(
    Effect.map((text) =>
      text === undefined ? undefined : { fileName: `${sessionId}.jsonl`, text },
    ),
  );
};

/** A URL without its query string or fragment, which may carry a credential. */
const withoutQuery = (url: string): string => {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

/** A record's body, and how long its sinks may keep retrying. */
interface Sending {
  readonly body: string;
  readonly giveUpMs: number;
}

const sendTo = (url: string, method: DeliveryMethod, sending: Sending) =>
  deliver({ url, method, ...sending }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.map((status) => ({ url: withoutQuery(url), status })),
  );

/** Sends the record to the sinks that run in the sandbox; the pointer says how each went. */
const sendRemote = (
  record: RecordRequest,
  secrets: RecordSecrets,
  sending: Sending,
): Effect.Effect<SessionRecordPointer | undefined> => {
  const key =
    secrets.webhookSecret === undefined
      ? undefined
      : signingKey(secrets.webhookSecret);
  const { upload } = secrets;
  const { webhookUrl, id } = record;
  if (upload === undefined && (webhookUrl === undefined || key === undefined)) {
    return nothing;
  }
  return Effect.all(
    {
      upload:
        upload === undefined
          ? nothing
          : sendTo(
              upload.url,
              { kind: "upload", headers: upload.headers },
              sending,
            ),
      webhook:
        webhookUrl === undefined || key === undefined
          ? nothing
          : sendTo(webhookUrl, { kind: "webhook", key, id }, sending),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((sent) => ({
      id,
      ...(sent.upload === undefined ? {} : { upload: sent.upload }),
      ...(sent.webhook === undefined ? {} : { webhook: sent.webhook }),
    })),
  );
};

/** Builds and sends the session's record, if it asked for one; the outcome then points to it. */
export const recordSession = (
  recording: Recording,
  outcome: SessionOutcome,
): Effect.Effect<SessionOutcome> => {
  const { request } = recording;
  const { record } = request;
  if (record === undefined) {
    return Effect.succeed(outcome);
  }
  return Effect.gen(function* () {
    const native = yield* nativeOf(request, outcome);
    const env = yield* envValues(record.redact.envVars, recording.sessionEnv);
    const built = buildSessionRecord(
      {
        request,
        record,
        outcome,
        events: recording.events,
        startedAt: recording.startedAt,
        endedAt: DateTime.formatIso(yield* DateTime.now),
        detachId: recording.detachId(),
        native,
      },
      redactor(record.redact, env),
    );
    const body = yield* encodeRecord(built);
    if (record.toHost) {
      recording.emit({ type: "record", record: built });
    }
    const now = yield* Clock.currentTimeMillis;
    const giveUpMs = Math.max(
      0,
      Math.min(MAX_DELIVERY_MS, recording.killAtMs - now),
    );
    const pointer = yield* sendRemote(record, recording.secrets, {
      body,
      giveUpMs,
    });
    return pointer === undefined ? outcome : { ...outcome, record: pointer };
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.as(Effect.logError("session record failed", cause), outcome),
    ),
  );
};
