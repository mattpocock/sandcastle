import { randomUUID } from "node:crypto";
import path from "node:path";
import { DateTime } from "effect";
import { sealSecret } from "./sealedSecret.js";
import type { SessionRecordOptions } from "./SessionRecord.js";
import type { RecordRequest, RecordSecrets } from "./sessionRecordSchema.js";
import { signingKey } from "./webhookSignature.js";

// Host side, before a session starts: checks its `record` option and builds
// the part of the request the supervisor records it with. The upload URL and
// the webhook secret are sealed to the supervisor's key, like the finish
// report's secret, so neither sits in a file a session could read.

/** Where the sandbox is, for its sessions' records. */
export interface RecordTarget {
  readonly sandboxId: string;
  readonly killTime: Date;
  /** The supervisor's public key, which the sinks are sealed to. */
  readonly publicKey: string;
}

const checkUrl = (name: string, url: string): void => {
  const protocol = URL.canParse(url) ? new URL(url).protocol : "";
  if (protocol !== "https:" && protocol !== "http:") {
    throw new TypeError(`session: ${name} must be an http: or https: URL`);
  }
};

const checkStrings = (
  name: string,
  values: Readonly<Record<string, unknown>> | readonly unknown[],
): void => {
  if (Object.values(values).some((value) => typeof value !== "string")) {
    throw new TypeError(`session: ${name} must hold only strings`);
  }
};

const check = (options: SessionRecordOptions): void => {
  const { upload, webhook, directory } = options;
  if (upload !== undefined) {
    checkUrl("record.upload.url", upload.url);
    checkStrings("record.upload.headers", upload.headers ?? {});
  }
  if (webhook !== undefined) {
    checkUrl("record.webhook.url", webhook.url);
    if (signingKey(webhook.secret) === undefined) {
      throw new TypeError(
        "session: record.webhook.secret must be a Standard Webhooks secret: `whsec_` plus base64, or bare base64",
      );
    }
  }
  if (directory !== undefined && !path.isAbsolute(directory.path)) {
    throw new TypeError(
      "session: record.directory.path must be an absolute path on your machine",
    );
  }
  checkStrings("record.labels", options.labels ?? {});
  checkStrings("record.redact.patterns", options.redact?.patterns ?? []);
  checkStrings("record.redact.envVars", options.redact?.envVars ?? []);
};

const sealed = (
  options: SessionRecordOptions,
  publicKey: string,
): string | undefined => {
  const { upload, webhook } = options;
  if (upload === undefined && webhook === undefined) {
    return undefined;
  }
  const secrets: RecordSecrets = {
    ...(upload === undefined
      ? {}
      : { upload: { url: upload.url, headers: { ...upload.headers } } }),
    ...(webhook === undefined ? {} : { webhookSecret: webhook.secret }),
  };
  return sealSecret(publicKey, JSON.stringify(secrets));
};

/** The `record` part of a session's request; throws on options that can't work. */
export const recordRequest = (
  options: SessionRecordOptions,
  target: RecordTarget,
): RecordRequest => {
  check(options);
  const secrets = sealed(options, target.publicKey);
  const now = DateTime.unsafeNow().epochMillis;
  return {
    id: randomUUID(),
    sandboxId: target.sandboxId,
    labels: { ...options.labels },
    redact: {
      patterns: [...(options.redact?.patterns ?? [])],
      envVars: [...(options.redact?.envVars ?? [])],
    },
    ...(options.webhook === undefined
      ? {}
      : { webhookUrl: options.webhook.url }),
    ...(secrets === undefined ? {} : { sealed: secrets }),
    toHost: options.directory !== undefined || options.onRecord !== undefined,
    killInMs: Math.max(0, target.killTime.getTime() - now),
  };
};
