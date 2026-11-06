import type { WriteStream } from "node:fs";
import { Effect } from "effect";
import type { AgentProvider } from "../AgentProvider.js";
import { shellEscape } from "../AgentProvider.js";
import { acceptsInput, STREAMING_INPUT_FLAGS, userLine } from "./agentInput.js";
import type { AgentProcess } from "./agentProcess.js";
import { startAgentProcess } from "./agentProcess.js";
import type { SessionRequest } from "./supervisorProtocol.js";

// Inside the sandbox: the agent's command line for a session, with its env,
// started. An agent that takes input reads its prompt as the first message
// on a stdin that stays open (agentInput.ts); every other agent reads it as
// text on a stdin that closes at once.

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** `export K='v'; …` for the agent's and the session's env, then the command. */
const withEnv = (
  env: Readonly<Record<string, string>>,
  command: string,
): string =>
  Object.entries(env)
    .filter(([key]) => ENV_KEY.test(key))
    .map(([key, value]) => `export ${key}=${shellEscape(value)}; `)
    .join("") + command;

const agentEnv = (options: Readonly<Record<string, unknown>>) => {
  const { env } = options;
  if (typeof env !== "object" || env === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

/** What launching a session's agent needs. */
export interface LaunchOptions {
  readonly request: SessionRequest;
  readonly agent: AgentProvider;
  /** Turns the agent's real command into the one to run (a fake agent replays instead). */
  readonly command: (realCommand: string) => string;
  readonly log: WriteStream;
}

/** Starts the agent's process with the session's env; returns it and that env. */
export const launchAgent = (
  options: LaunchOptions,
): Effect.Effect<{
  readonly process: AgentProcess;
  readonly env: Readonly<Record<string, string>>;
}> =>
  Effect.gen(function* () {
    const { request, agent } = options;
    const print = agent.buildPrintCommand({
      prompt: request.prompt,
      dangerouslySkipPermissions: true,
      ...(request.resumeSessionId === undefined
        ? {}
        : { resumeSession: request.resumeSessionId }),
    });
    const env = { ...agentEnv(request.agent.options), ...request.env };
    const streaming = acceptsInput(request.agent.id);
    const command = streaming
      ? `${print.command}${STREAMING_INPUT_FLAGS}`
      : print.command;
    const process = yield* startAgentProcess({
      command: withEnv(env, options.command(command)),
      workingDirectory: request.workingDirectory,
      stdin: streaming ? userLine(print.stdin ?? request.prompt) : print.stdin,
      keepInputOpen: streaming,
      log: options.log,
    });
    return { process, env };
  });
