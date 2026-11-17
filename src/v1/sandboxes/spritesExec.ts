import { randomUUID } from "node:crypto";
import type { Sprite } from "@fly/sprites";
import { shellEscape } from "../../AgentProvider.js";
import type {
  ProviderExecOptions,
  ProviderExecResult,
} from "../SandboxProvider.js";
import { streamCommand } from "./spritesStream.js";

// Running commands in a sprite. Env travels as a file in a private folder in
// the sprite, which the command sources and deletes as it starts, and the
// host deletes again once it's done with the command, in case it never
// started: the SDK's own `env` would put it in the exec URL.

/** A sprite, and what every command in it gets. */
export interface SpritesExecContext {
  readonly sprite: Sprite;
  /** Where commands start. */
  readonly workingDirectory: string;
  /** The sandbox's env, for every command. */
  readonly env: Readonly<Record<string, string>>;
}

/** A command ready to run, and the private folder holding its env, if any. */
export interface PreparedCommand {
  /** The shell script: env sourced, folder removed, `cd`, the command. */
  readonly script: string;
  readonly folder: string | undefined;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Lines that export `env` when sourced, or `undefined` when it's empty. */
const envScript = (
  env: Readonly<Record<string, string>>,
): string | undefined => {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return undefined;
  }
  return entries
    .map(([key, value]) => {
      if (!ENV_KEY.test(key)) {
        throw new TypeError(`sprites: invalid env var name "${key}"`);
      }
      return `export ${key}=${shellEscape(value)}\n`;
    })
    .join("");
};

/** Deletes a command's private folder, if it still exists. Never rejects. */
export const discard = async (
  sprite: Sprite,
  folder: string | undefined,
): Promise<void> => {
  if (folder !== undefined) {
    await sprite
      .filesystem()
      .rm(folder, { recursive: true, force: true })
      .catch(() => undefined);
  }
};

/** Writes the env file into a folder only the sprite user can read. */
const writeEnvFile = async (
  sprite: Sprite,
  folder: string,
  content: string,
): Promise<void> => {
  const fs = sprite.filesystem();
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.writeFile(`${folder}/env`, content, { mode: 0o600 });
};

/**
 * `command` as a script: its env sourced from a file and that file's folder
 * removed before it runs, in its directory. Writes the env file.
 */
export const prepare = async (
  context: SpritesExecContext,
  options: Pick<ProviderExecOptions, "command" | "workingDirectory" | "env">,
): Promise<PreparedCommand> => {
  const env = envScript({ ...context.env, ...options.env });
  const folder =
    env === undefined ? undefined : `/tmp/sandcastle-${randomUUID()}`;
  if (folder !== undefined && env !== undefined) {
    await writeEnvFile(context.sprite, folder, env).catch(
      async (error: unknown) => {
        await discard(context.sprite, folder);
        throw error;
      },
    );
  }
  const script = [
    ...(folder === undefined ? [] : [`. ${folder}/env`, `rm -rf ${folder}`]),
    `cd ${shellEscape(options.workingDirectory ?? context.workingDirectory)} || exit 1`,
    options.command,
  ].join("\n");
  return { script, folder };
};

/** Runs a command and waits for it, streaming its stdout line by line. With `sudo`, all of it runs as root. */
export const spritesExec = async (
  context: SpritesExecContext,
  options: ProviderExecOptions,
): Promise<ProviderExecResult> => {
  const { script, folder } = await prepare(context, options);
  const line =
    options.sudo === true ? `sudo sh -c ${shellEscape(script)}` : script;
  try {
    return await streamCommand(context.sprite, line, {
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.onLine === undefined ? {} : { onLine: options.onLine }),
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
    });
  } finally {
    // Gone already unless the command never got to remove it.
    await discard(context.sprite, folder);
  }
};
