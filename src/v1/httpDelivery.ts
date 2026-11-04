import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { HttpClientResponse } from "@effect/platform";
import { Clock, Duration, Effect } from "effect";
import { signMessage } from "./webhookSignature.js";

// Inside the sandbox: sends a JSON body over HTTP, the finish report and
// session records alike. A Standard Webhook POST is signed afresh for each
// attempt; an upload is a plain PUT. Any answer but 2xx is retried with
// backoff (or after the receiver's `Retry-After`), except 410 Gone, which
// stops it. It gives up once the next attempt would land past `giveUpMs`.

/** What delivery came to. */
export type DeliveryResult = "delivered" | "gone" | "gave-up";

/** How a body is sent: a signed Standard Webhook POST, or a plain PUT. */
export type DeliveryMethod =
  | {
      readonly kind: "webhook";
      /** The HMAC key from the secret. */
      readonly key: Buffer;
      /** The `webhook-id`. */
      readonly id: string;
    }
  | {
      readonly kind: "upload";
      readonly headers: Readonly<Record<string, string>>;
    };

/** What to deliver, and where. */
export interface Delivery {
  readonly url: string;
  readonly method: DeliveryMethod;
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

/** The request for one attempt, signed with `timestamp` when it's a webhook. */
const requestFor = (
  delivery: Delivery,
  timestamp: string,
): HttpClientRequest.HttpClientRequest => {
  const { method, body } = delivery;
  if (method.kind === "upload") {
    return HttpClientRequest.put(delivery.url).pipe(
      HttpClientRequest.bodyText(body, "application/json"),
      HttpClientRequest.setHeaders(method.headers),
    );
  }
  const { id, key } = method;
  return HttpClientRequest.post(delivery.url).pipe(
    HttpClientRequest.setHeaders({
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signMessage(key, { id, timestamp, body }),
    }),
    HttpClientRequest.bodyText(body, "application/json"),
  );
};

const tryOnce = (
  delivery: Delivery,
): Effect.Effect<Answer, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const now = yield* Clock.currentTimeMillis;
    const request = requestFor(delivery, String(Math.floor(now / 1000)));
    const answered = yield* client.execute(request).pipe(
      Effect.tap((response) => Effect.ignore(response.text)),
      Effect.timeout(ATTEMPT_TIMEOUT),
      Effect.either,
    );
    return answered._tag === "Left"
      ? { kind: "retry" }
      : answerOf(answered.right);
  });

/** Delivers a body, retrying until it's taken, refused with 410, or out of time. */
export const deliver = (
  delivery: Delivery,
): Effect.Effect<DeliveryResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    for (let attempt = 0; ; attempt += 1) {
      const answer = yield* tryOnce(delivery);
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
