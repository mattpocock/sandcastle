import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FetchHttpClient } from "@effect/platform";
import { Clock, DateTime, Duration, Effect, Schema } from "effect";
import type { EndedSession } from "./finishReportBuild.js";
import { buildFinishReport } from "./finishReportBuild.js";
import { deliver as send } from "./httpDelivery.js";
import { FinishReportJson } from "./finishReportSchema.js";
import type { DetachRequest, SessionRequest } from "./supervisorProtocol.js";
import type { RunningSession } from "./supervisorSession.js";
import { signingKey } from "./webhookSignature.js";

// Inside the sandbox, after a detach: the supervisor carries the running
// sessions on without the host, stops whatever is left at the deadline
// (`time-limit`), then writes the finish report to a file and, given a
// destination, delivers it. The secret is a parameter here and nothing else:
// it's never written, logged or put in a session's env.

/** A session the supervisor carries on past a detach. */
export interface CarriedSession {
  readonly request: SessionRequest;
  readonly session: RunningSession;
}

/** Where finish reports are written, relative to the supervisor's directory. */
export const REPORTS_DIRECTORY = "reports";

/** Waits for every carried session to end, in the order they end; kills what's left at the deadline. */
const endAll = (
  carried: readonly CarriedSession[],
  deadlineMs: number,
): Effect.Effect<EndedSession[]> =>
  Effect.gen(function* () {
    const ended: EndedSession[] = [];
    const all = Effect.all(
      carried.map(({ request, session }) =>
        session.outcome.pipe(
          Effect.tap((outcome) => {
            ended.push({ request, outcome });
          }),
        ),
      ),
      { concurrency: "unbounded", discard: true },
    );
    const deadline = Effect.sleep(Duration.millis(deadlineMs)).pipe(
      Effect.andThen(
        Effect.all(
          carried.map(({ session }) => session.kill("time-limit")),
          { discard: true },
        ),
      ),
      Effect.andThen(Effect.never),
    );
    yield* Effect.race(all, deadline);
    return ended;
  });

const writeReport = (detachId: string, body: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await mkdir(REPORTS_DIRECTORY, { recursive: true });
    await writeFile(path.join(REPORTS_DIRECTORY, `${detachId}.json`), body, {
      mode: 0o600,
    });
  });

/** A detach, as the supervisor carries it out. */
export interface Detached {
  readonly carried: readonly CarriedSession[];
  readonly request: DetachRequest;
  /** The opened finish-report secret, when a destination was given. */
  readonly secret: string | undefined;
  /** Called once the report is written and delivered. */
  readonly finished: () => void;
}

const encodeReport = Schema.encode(FinishReportJson);

/** Delivers the report, if there's somewhere and a key to sign it with. */
const deliver = (
  detached: Detached,
  body: string,
  remainingMs: number,
): Effect.Effect<string> => {
  const { request, secret } = detached;
  const key = secret === undefined ? undefined : signingKey(secret);
  if (request.finishReport === undefined || key === undefined) {
    return Effect.succeed("written");
  }
  return send({
    url: request.finishReport.url,
    method: { kind: "webhook", key, id: request.detachId },
    body,
    giveUpMs: remainingMs,
  }).pipe(Effect.provide(FetchHttpClient.layer));
};

/** Carries the sessions on to the end, then writes and delivers the finish report. */
export const carryOn = (detached: Detached): void => {
  const { request } = detached;
  const program = Effect.gen(function* () {
    const detachedAt = yield* Clock.currentTimeMillis;
    const ended = yield* endAll(detached.carried, request.deadlineMs);
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const body = yield* encodeReport(
      buildFinishReport(request, ended, timestamp),
    );
    yield* writeReport(request.detachId, body);
    // Until the kill time, which was `giveUpMs` away at the detach.
    const elapsed = (yield* Clock.currentTimeMillis) - detachedAt;
    const result = yield* deliver(detached, body, request.giveUpMs - elapsed);
    yield* Effect.logInfo(`finish report ${request.detachId}: ${result}`);
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("finish report failed", cause),
    ),
    Effect.ensuring(Effect.sync(detached.finished)),
  );
  Effect.runFork(program);
};
