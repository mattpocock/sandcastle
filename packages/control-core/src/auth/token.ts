import { randomBytes } from "node:crypto";

export const generateToken = (): string =>
  randomBytes(32).toString("base64url");

export const resolveToken = (provided?: string): string =>
  provided ?? process.env.SANDCASTLE_CONTROL_TOKEN ?? generateToken();
