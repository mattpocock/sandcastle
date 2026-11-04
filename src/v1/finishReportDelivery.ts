import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { HttpClientResponse } from "@effect/platform";
import { Clock, Duration, Effect } from "effect";
import { signMessage } from "./webhookSignature.js";

// Inside the sandbox: POSTs a finish report as a Standard Webhook, signed
// afresh for each attempt. Any answer but 2xx is retried with backoff (or
// after the receiver's `Retry-After`), except 410 Gone, which stops it. It
// gives up once the next attempt would land past the sandbox's kill time.

/** What delivery came to. */
export type DeliveryResult = "delivered" | "gone" | "gave-up";

/** What to deliver, and where. */
export interface Delivery {
  readonly url: string;
  /** The HMAC key from the detach's secret. */
  readonly key: Buffer;
  /** The detach id: the `webhook-id`. */
  readonly id: string;
  readonly body: string;
  /** How long it may keep retrying, from the start. */
  readonly giveUpMs: number;
}

const ATTEMPT_TIMEOUT = "30 seconds";
const MAX_WAIT_MS = 60_000;

type Answer =
  | { readonly kind: "delivered" | "gone" }
  | { readonly kind: "retry"; readonly afterMs?: number };

/** The wait a receiver asked for in `Retry-After` (seconds), if it did. */
const retryAfter = (
  response: HttpClientResponse.HttpClientResponse,
): number | undefined => {
  const header = response.headers["retry-after"] ?? "";
  const seconds = header === "" ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_WAIT_MS)
    : undefined;
};

const answerOf = (response: HttpClientResponse.HttpClientResponse): Answer => {
  const { status } = response;
  if (status >= 200 && status < 300) {
    return { kind: "delivered" };
  }
  if (status === 410) {
    return { kind: "gone" };
  }
  const afterMs = retryAfter(response);
  return afterMs === undefined ? { kind: "retry" } : { kind: "retry", afterMs };
};

const post = (
  delivery: Delivery,
): Effect.Effect<Answer, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const now = yield* Clock.currentTimeMillis;
    const timestamp = String(Math.floor(now / 1000));
    const { id, body } = delivery;
    const request = HttpClientRequest.post(delivery.url).pipe(
      HttpClientRequest.setHeaders({
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signMessage(delivery.key, { id, timestamp, body }),
      }),
      HttpClientRequest.bodyText(body, "application/json"),
    );
    const answered = yield* client.execute(request).pipe(
      Effect.tap((response) => Effect.ignore(response.text)),
      Effect.timeout(ATTEMPT_TIMEOUT),
      Effect.either,
    );
    return answered._tag === "Left"
      ? { kind: "retry" }
      : answerOf(answered.right);
  });

/** Delivers a finish report, retrying until it's taken, refused with 410, or out of time. */
export const deliverFinishReport = (
  delivery: Delivery,
): Effect.Effect<DeliveryResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    for (let attempt = 0; ; attempt += 1) {
      const answer = yield* post(delivery);
      if (answer.kind !== "retry") {
        return answer.kind;
      }
      const waitMs =
        answer.afterMs ?? Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
      const now = yield* Clock.currentTimeMillis;
      if (now + waitMs - start > delivery.giveUpMs) {
        return "gave-up";
      }
      yield* Effect.sleep(Duration.millis(waitMs));
    }
  });
