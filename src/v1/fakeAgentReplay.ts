import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { Duration, Effect, Either, Schema } from "effect";
import { converse } from "./fakeAgentConversation.js";
import { claudeSessionFile } from "./sessionUsage.js";
import { AgentId, ReplayScript } from "./supervisorProtocol.js";

// A fake agent, run by the supervisor in place of the real CLI: it prints a
// recorded stream instead of calling a model. The real command line follows
// it on argv, so it sees the flags the supervisor built. For Claude Code it
// also keeps a session file where Claude Code would, so a continued session
// (`--resume <id>`) finds its conversation only in the same sandbox and
// working directory, as with the real CLI. Started with streaming input, a
// Claude Code fake holds a conversation (fakeAgentConversation.ts).

/** What the supervisor writes for a fake agent to replay. */
export const ReplayFile = Schema.Struct({
  format: AgentId,
  ...ReplayScript.fields,
});

/** What the supervisor writes for a fake agent to replay. */
export type ReplayFile = typeof ReplayFile.Type;

const decodeReplay = Schema.decodeUnknownEither(Schema.parseJson(ReplayFile));

const InitLine = Schema.parseJson(
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("init"),
    session_id: Schema.String,
  }),
);

const sessionIdOf = (lines: readonly string[]): string | undefined =>
  lines
    .map((line) => Schema.decodeUnknownOption(InitLine)(line))
    .find((init) => init._tag === "Some")?.value.session_id;

const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Claude Code's session file for this conversation, made like the real CLI makes it. */
const claudeSession = async (
  lines: readonly string[],
  prompt: string,
): Promise<string | undefined> => {
  const sessionId = sessionIdOf(lines);
  if (sessionId === undefined) {
    return undefined;
  }
  const file = claudeSessionFile(process.cwd(), sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const user = { type: "user", message: { role: "user", content: prompt } };
  await appendFile(file, `${JSON.stringify(user)}\n`);
  return file;
};

/** Fails like the real CLI when a resumed conversation isn't there; `undefined` when it is. */
const missingConversation = async (
  argv: readonly string[],
): Promise<number | undefined> => {
  const resumeAt = argv.indexOf("--resume");
  const resumeId = resumeAt === -1 ? undefined : argv[resumeAt + 1];
  if (
    resumeId === undefined ||
    (await exists(claudeSessionFile(process.cwd(), resumeId)))
  ) {
    return undefined;
  }
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  return 1;
};

/** Replays a fake agent's script; resolves with its exit code. */
export const runReplay = async (
  scriptFile: string,
  argv: readonly string[],
): Promise<number> => {
  const script = Either.getOrThrow(
    decodeReplay(await readFile(scriptFile, "utf8")),
  );
  const claude = script.format === "claude-code";
  const missing = claude ? await missingConversation(argv) : undefined;
  if (missing !== undefined) {
    return missing;
  }
  const stream = script.lines.map((line) => `${line}\n`).join("");
  const keepSession = async (prompt: string): Promise<void> => {
    const sessionFile = claude
      ? await claudeSession(script.lines, prompt)
      : undefined;
    if (sessionFile !== undefined) {
      await appendFile(sessionFile, stream);
    }
  };
  if (claude && argv.includes("--input-format")) {
    return converse({
      lines: script.lines,
      exitCode: script.exitCode,
      hang: script.hang,
      inputDelayMs: script.inputDelayMs ?? 0,
      sessionId: sessionIdOf(script.lines),
      onPrompt: keepSession,
    });
  }
  await keepSession(await text(process.stdin));
  process.stdout.write(stream);
  if (script.hang) {
    await Effect.runPromise(Effect.sleep(Duration.days(1)));
  }
  return script.exitCode;
};
