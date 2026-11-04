import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { AgentProvider, IterationUsage } from "../AgentProvider.js";
import { encodeProjectPath } from "../SessionStore.js";
import type { StreamState } from "./sessionStream.js";

// Inside the sandbox, after a session ends: its token usage. Claude Code's
// stream only has the turn's summed usage, so (as on 0.x) it's read from the
// last assistant message in the session file Claude Code wrote under the
// sandbox user's home. Other agents report usage in their stream.

/** Where Claude Code keeps a session started in `workingDirectory`. */
export const claudeSessionFile = (
  workingDirectory: string,
  sessionId: string,
): string =>
  path.join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectPath(workingDirectory),
    `${sessionId}.jsonl`,
  );

/**
 * The text of Claude Code's session file for `sessionId`, if it's there. The
 * agent names its project by the directory as it sees it, which can be the
 * resolved path where the given one runs through a symlink (macOS's temp
 * dir), so both are tried.
 */
export const claudeSessionText = (
  workingDirectory: string,
  sessionId: string,
): Effect.Effect<string | undefined> => {
  const read = (directory: string) =>
    Effect.tryPromise(() =>
      readFile(claudeSessionFile(directory, sessionId), "utf8"),
    );
  return read(workingDirectory).pipe(
    Effect.orElse(() =>
      Effect.tryPromise(() => realpath(workingDirectory)).pipe(
        Effect.flatMap(read),
      ),
    ),
    Effect.orElseSucceed(() => undefined),
  );
};

/** The session's usage, from its session file where the agent reads it from there. */
export const sessionUsage = (
  agent: AgentProvider,
  workingDirectory: string,
  stream: StreamState,
): Effect.Effect<IterationUsage | undefined> => {
  const { sessionId } = stream;
  if (agent.parseSessionUsage === undefined || sessionId === undefined) {
    return Effect.succeed(stream.usage);
  }
  return claudeSessionText(workingDirectory, sessionId).pipe(
    Effect.map((content) =>
      content === undefined
        ? stream.usage
        : (agent.parseSessionUsage?.(content) ?? stream.usage),
    ),
  );
};
