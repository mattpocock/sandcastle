import { createHmac, timingSafeEqual } from "node:crypto";

// Standard Webhooks signing, shared by the supervisor (which signs finish
// reports) and verifyFinishReport (which checks them): the signature is
// `v1,` plus the base64 HMAC-SHA256 of `<id>.<timestamp>.<body>`, keyed with
// the secret's base64-decoded bytes.

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** The HMAC key in a `whsec_…` or bare base64 secret, or `undefined` when it isn't one. */
export const signingKey = (secret: string): Buffer | undefined => {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) {
    return undefined;
  }
  const key = Buffer.from(encoded, "base64");
  return key.length === 0 ? undefined : key;
};

/** One signed message: the webhook id, its unix timestamp in seconds, and the exact body. */
export interface SignedMessage {
  readonly id: string;
  readonly timestamp: string;
  readonly body: string;
}

const hmac = (key: Buffer, message: SignedMessage): Buffer =>
  createHmac("sha256", key)
    .update(`${message.id}.${message.timestamp}.${message.body}`, "utf8")
    .digest();

/** The `webhook-signature` header for a message. */
export const signMessage = (key: Buffer, message: SignedMessage): string =>
  `v1,${hmac(key, message).toString("base64")}`;

/** Whether any `v1,` signature in a `webhook-signature` header matches the message. */
export const signatureMatches = (
  key: Buffer,
  message: SignedMessage,
  header: string,
): boolean => {
  const expected = hmac(key, message);
  return header.split(" ").some((entry) => {
    const [version, value = ""] = entry.split(",");
    const given = Buffer.from(value, "base64");
    return (
      version === "v1" &&
      given.length === expected.length &&
      timingSafeEqual(given, expected)
    );
  });
};
