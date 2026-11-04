import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { agentDescriptor } from "./agents.js";
import type { SessionOptions } from "./Session.js";
import type { SessionRequest } from "./supervisorProtocol.js";

// Host side, before a session starts: checks its options and builds the
// request the supervisor runs. Everything here fails before anything runs.

const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
const DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const positiveMs = (
  name: string,
  seconds: number | undefined,
  fallback: number,
): number => {
  const value = seconds ?? fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `session: ${name} must be a positive number, got ${value}`,
    );
  }
  return value * 1000;
};

/** The directory the session runs in, and the session it continues, if any. */
const placement = (
  options: SessionOptions,
  sandboxDirectory: string,
  agentId: string,
): { readonly workingDirectory: string; readonly resumeSessionId?: string } => {
  const asked =
    options.workingDirectory === undefined
      ? undefined
      : posix.resolve(sandboxDirectory, options.workingDirectory);
  const earlier = options.continueSession;
  if (earlier === undefined) {
    return { workingDirectory: asked ?? sandboxDirectory };
  }
  if (earlier.sessionId === undefined || earlier.agent !== agentId) {
    throw new TypeError(
      `session: continueSession needs a result from a ${agentId} session that reported a session id`,
    );
  }
  if (asked !== undefined && asked !== earlier.workingDirectory) {
    throw new TypeError(
      `session: a continued session runs in the directory of the one it continues (${earlier.workingDirectory})`,
    );
  }
  return {
    workingDirectory: earlier.workingDirectory,
    resumeSessionId: earlier.sessionId,
  };
};

const checkPrompt = (options: SessionOptions): void => {
  if (typeof options.prompt !== "string") {
    throw new TypeError("session: `prompt` must be a string");
  }
  // ADR 0020: the agent can only print the output if the prompt asks for it.
  const { output } = options;
  if (output !== undefined && !options.prompt.includes(`<${output.tag}>`)) {
    throw new TypeError(
      `session: output tag <${output.tag}> not found in the prompt. The prompt must tell the agent to put its result between <${output.tag}> and </${output.tag}>.`,
    );
  }
};

const checkEnv = (env: Readonly<Record<string, string>>): void => {
  for (const key of Object.keys(env)) {
    if (!ENV_KEY.test(key)) {
      throw new TypeError(`session: invalid env var name "${key}"`);
    }
  }
};

/** The supervisor's request for a session; throws on options that can't run. */
export const sessionRequest = (
  options: SessionOptions,
  context: { readonly name: string; readonly workingDirectory: string },
): SessionRequest => {
  checkPrompt(options);
  const agent = agentDescriptor(options.agent);
  const env = { ...options.env };
  checkEnv(env);
  const { output } = options;
  return {
    type: "session",
    id: randomUUID(),
    name: context.name,
    agent,
    prompt: options.prompt,
    env,
    idleTimeoutMs: positiveMs(
      "idleTimeoutSeconds",
      options.idleTimeoutSeconds,
      DEFAULT_IDLE_TIMEOUT_SECONDS,
    ),
    completionTimeoutMs: positiveMs(
      "completionTimeoutSeconds",
      options.completionTimeoutSeconds,
      DEFAULT_COMPLETION_TIMEOUT_SECONDS,
    ),
    ...placement(options, context.workingDirectory, agent.id),
    ...(output === undefined
      ? {}
      : { output: { kind: output._tag, tag: output.tag } }),
  };
};
