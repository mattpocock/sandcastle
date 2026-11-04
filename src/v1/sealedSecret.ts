import type { KeyObject } from "node:crypto";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPair,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { promisify } from "node:util";

// The finish report's secret crosses from the host to the session supervisor
// sealed (ADR 0027, 0028): the supervisor makes a key pair in memory at start
// and hands the host the public half in its hello, before any session runs.
// The host seals the secret to it; only the supervisor's memory can open it.
// Sealing is hybrid, so a secret of any length fits: a fresh AES-256-GCM key
// encrypts the secret, and RSA-OAEP wraps that key.

const OAEP = {
  padding: constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: "sha256",
} as const;

/** The supervisor's key pair: the public half as PEM, the private half never leaves memory. */
export interface SealingKeys {
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

const generateRsa = promisify(generateKeyPair);

/** Makes the supervisor's key pair. */
export const makeSealingKeys = async (): Promise<SealingKeys> => {
  const { publicKey, privateKey } = await generateRsa("rsa", {
    modulusLength: 2048,
  });
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey,
  };
};

/** Seals `secret` to the supervisor's public key. */
export const sealSecret = (publicKey: string, secret: string): string => {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    publicEncrypt({ key: publicKey, ...OAEP }, key),
    iv,
    cipher.getAuthTag(),
    sealed,
  ]
    .map((part) => part.toString("base64"))
    .join(".");
};

/** Opens a sealed secret with the private key; `undefined` when it wasn't sealed to it. */
export const openSecret = (
  privateKey: KeyObject,
  sealed: string,
): string | undefined => {
  const [wrapped, iv, tag, body] = sealed
    .split(".")
    .map((part) => Buffer.from(part, "base64"));
  if (
    wrapped === undefined ||
    iv === undefined ||
    tag === undefined ||
    body === undefined
  ) {
    return undefined;
  }
  try {
    const key = privateDecrypt({ key: privateKey, ...OAEP }, wrapped);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return undefined;
  }
};
