/**
 * @internal How noSandbox runs a command on Windows (issue #940).
 *
 * Sandcastle builds every exec command as a POSIX shell string (agent print
 * commands quote their values with `shellEscape`), because docker, podman,
 * vercel and daytona all run it with `sh -c`. Windows has no `sh`, and cmd.exe
 * does not understand POSIX quoting, so handing that string to cmd.exe
 * delivers `'claude-fable-5'`, quotes and all.
 *
 * Instead of re-quoting the string for cmd.exe, noSandbox splits it back into
 * the argv it stands for and launches the program directly:
 *
 * - an `.exe` gets the argv array with no shell at all; Node's own argv
 *   quoting handles spaces, quotes, `%`, `^`, `&`, `|` and newlines;
 * - a `.cmd`/`.bat` (how npm installs agent CLIs on Windows) can only run
 *   under cmd.exe, so its command line is escaped with the standard rules
 *   for a batch file that forwards `%*` (as cross-spawn does);
 * - anything that is not a simple command (pipes, redirects, `$VAR`, cmd.exe
 *   builtins, Windows-style `%VAR%`) goes to cmd.exe unchanged, as before.
 */
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { parseSimpleCommand } from "./posixSimpleCommand.js";

/** How to spawn a command: `file` with `args`, no shell. */
export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

type Env = Record<string, string | undefined>;

/**
 * Read an env var the way Windows does: names are case-insensitive, and when
 * an env object holds two spellings (`Path` and `PATH`), Node's spawn uses
 * the lexicographically first, so this does too.
 */
const getEnv = (env: Env, name: string): string | undefined => {
  const key = Object.keys(env)
    .filter((k) => k.toUpperCase() === name)
    .reduce<string | undefined>(
      (first, k) => (first === undefined || k < first ? k : first),
      undefined,
    );
  return key === undefined ? undefined : env[key];
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
};

/** The paths Windows would try for `program`, in order. */
const candidatePaths = (program: string, env: Env, cwd: string): string[] => {
  const pathExt = (getEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((ext) => ext !== "")
    .map((ext) => ext.toLowerCase());
  const hasExt = pathExt.includes(win32.extname(program).toLowerCase());
  const withExts = (base: string) =>
    hasExt ? [base] : pathExt.map((ext) => `${base}${ext}`);

  if (/[\\/]/u.test(program) || win32.isAbsolute(program)) {
    return withExts(win32.resolve(cwd, program));
  }
  return (getEnv(env, "PATH") ?? "")
    .split(";")
    .map((dir) => dir.replaceAll('"', "").trim())
    .filter((dir) => dir !== "")
    .flatMap((dir) => withExts(win32.join(dir, program)));
};

/**
 * Find the file Windows would run for `program`: an explicit path (relative
 * to `cwd`), or the first PATH directory holding `program` with a PATHEXT
 * extension. Returns undefined when nothing matches (cmd.exe builtins such
 * as `echo`, or a program that isn't installed).
 */
export const resolveWindowsProgram = async (
  program: string,
  env: Env,
  cwd: string,
): Promise<string | undefined> => {
  const candidates = candidatePaths(program, env, cwd);
  const found = await Promise.all(candidates.map(async (p) => isFile(p)));
  return candidates[found.indexOf(true)];
};

/** cmd.exe metacharacters, escaped with `^` (the set cross-spawn uses). */
const CMD_META = /(?<meta>[()\][%!^"`<>&|;, *?])/gu;

/** The longest command line cmd.exe accepts. */
export const CMD_MAX_COMMAND_LINE = 8191;

const escapeCmdMeta = (s: string): string => s.replaceAll(CMD_META, "^$<meta>");

/**
 * Quote one argument for a batch file run through `cmd.exe /d /s /c`.
 *
 * First quote it for the program the batch file ends up launching (the
 * Windows argv rules: backslashes double only before a quote or the end),
 * then `^`-escape every cmd.exe metacharacter twice: once for cmd.exe
 * reading the `/c` line, and once for the batch file's own `%*` line, which
 * cmd.exe parses again.
 */
const escapeBatchArgument = (arg: string): string => {
  const quoted = arg
    .replaceAll(/(?<bs>\\*)"/gu, String.raw`$<bs>$<bs>\"`)
    .replace(/(?<bs>\\*)$/u, "$<bs>$<bs>");
  return escapeCmdMeta(escapeCmdMeta(`"${quoted}"`));
};

/** Plan a batch file run under cmd.exe, refusing what cmd.exe can't carry. */
const planBatch = (
  program: string,
  file: string,
  { args, comspec }: { args: readonly string[]; comspec: string },
): SpawnPlan => {
  const name = win32.basename(file);
  if (args.some((arg) => /[\r\n]/u.test(arg))) {
    throw new Error(
      `${program} is a batch file (${name}), which runs under cmd.exe, and cmd.exe cannot pass an argument containing a newline. Pass that text on stdin instead.`,
    );
  }
  const commandLine = [
    escapeCmdMeta(file),
    ...args.map((arg) => escapeBatchArgument(arg)),
  ].join(" ");
  if (commandLine.length > CMD_MAX_COMMAND_LINE) {
    throw new Error(
      `The command line for ${program} (${name}) is too long for cmd.exe: ${commandLine.length} characters once escaped, over the ${CMD_MAX_COMMAND_LINE}-character limit. Pass long text on stdin instead.`,
    );
  }
  return {
    file: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
};

/**
 * Plan how to spawn `argv` on Windows without re-quoting it by hand where
 * that can be avoided. Resolves undefined when the program can't be found
 * on PATH, so the caller keeps its old cmd.exe behaviour.
 *
 * Rejects when a batch file would be handed an argument cmd.exe cannot carry
 * (a newline, or a command line over 8191 characters), rather than letting
 * cmd.exe silently cut the command short.
 */
export const planWindowsSpawn = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
): Promise<SpawnPlan | undefined> => {
  const [program, ...args] = argv;
  if (program === undefined) {
    return undefined;
  }
  const file = await resolveWindowsProgram(program, env, cwd);
  if (file === undefined) {
    return undefined;
  }
  const ext = win32.extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return planBatch(program, file, {
      args,
      comspec: getEnv(env, "COMSPEC") ?? "cmd.exe",
    });
  }
  return { file, args, windowsVerbatimArguments: false };
};

/**
 * Plan how noSandbox's `exec` runs a command string on Windows: as a direct
 * spawn when it is a simple command whose program is on PATH, otherwise
 * through `cmd.exe /d /s /c` unchanged (the behaviour before #940).
 */
export const planWindowsExec = async (
  command: string,
  env: Env,
  cwd: string,
): Promise<SpawnPlan & { readonly env: Env }> => {
  const simple = parseSimpleCommand(command);
  if (simple !== undefined) {
    const commandEnv = { ...env, ...simple.env };
    const plan = await planWindowsSpawn(simple.argv, commandEnv, cwd);
    if (plan !== undefined) {
      return { ...plan, env: commandEnv };
    }
  }
  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", command],
    windowsVerbatimArguments: true,
    env,
  };
};
