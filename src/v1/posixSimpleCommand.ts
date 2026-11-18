/**
 * @internal Splits a POSIX shell command back into the argv it stands for,
 * when it is a simple command. noSandbox uses it on Windows (issue #940),
 * where there is no `sh` to do this, so the program can be spawned directly
 * instead of handing POSIX quoting to cmd.exe. See `windowsCommand.ts`.
 */

/** A POSIX simple command: leading `export NAME=value;` statements, then argv. */
export interface SimpleCommand {
  readonly env: Record<string, string>;
  readonly argv: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Characters that make an unquoted word mean something to a POSIX shell
 * (operators, expansions, globs) or look like cmd.exe syntax (`%`, `^`).
 * A command containing one is not simple, and keeps the old cmd.exe path.
 */
const UNQUOTED_SPECIAL = "|&<>()$`*?[]{}~#!%^\n\r";

/** Ends the current word without being part of one. */
const SEPARATORS = " \t;";

/** Characters a backslash escapes inside POSIX double quotes. */
const DOUBLE_QUOTE_ESCAPABLE = '"\\$`';

/** A run of characters read from the command, and where reading stops. */
interface Piece {
  readonly text: string;
  readonly next: number;
}

const readSingleQuoted = (s: string, start: number): Piece | undefined => {
  const end = s.indexOf("'", start + 1);
  return end === -1
    ? undefined
    : { text: s.slice(start + 1, end), next: end + 1 };
};

const readDoubleQuoted = (s: string, start: number): Piece | undefined => {
  let text = "";
  let i = start + 1;
  while (i < s.length) {
    const c = s.charAt(i);
    const next = s.charAt(i + 1);
    if (c === '"') {
      return { text, next: i + 1 };
    }
    if (c === "$" || c === "`" || (c === "\\" && next === "\n")) {
      return undefined;
    }
    if (c === "\\" && next !== "" && DOUBLE_QUOTE_ESCAPABLE.includes(next)) {
      text += next;
      i += 2;
    } else {
      text += c;
      i += 1;
    }
  }
  return undefined;
};

const readBare = (s: string, start: number): Piece => {
  let i = start;
  while (
    i < s.length &&
    !SEPARATORS.includes(s.charAt(i)) &&
    !UNQUOTED_SPECIAL.includes(s.charAt(i)) &&
    !"'\"\\".includes(s.charAt(i))
  ) {
    i += 1;
  }
  return { text: s.slice(start, i), next: i };
};

/** Read the next piece of a word, or undefined if the command isn't simple. */
const readPiece = (s: string, start: number): Piece | undefined => {
  const c = s.charAt(start);
  if (c === "'") {
    return readSingleQuoted(s, start);
  }
  if (c === '"') {
    return readDoubleQuoted(s, start);
  }
  if (c === "\\") {
    // Only the `\'` that shellEscape emits. Any other bare backslash is more
    // likely a Windows path than a POSIX escape: leave it to cmd.exe.
    return s.charAt(start + 1) === "'"
      ? { text: "'", next: start + 2 }
      : undefined;
  }
  if (UNQUOTED_SPECIAL.includes(c)) {
    return undefined;
  }
  return readBare(s, start);
};

/** Split into statements (on `;`), each a list of words. */
const splitStatements = (s: string): string[][] | undefined => {
  const statements: string[][] = [[]];
  let word: string | undefined;
  const endWord = () => {
    if (word !== undefined) {
      statements.at(-1)?.push(word);
    }
    word = undefined;
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    const piece = SEPARATORS.includes(c) ? undefined : readPiece(s, i);
    if (piece !== undefined) {
      word = (word ?? "") + piece.text;
      i = piece.next;
    } else if (SEPARATORS.includes(c)) {
      endWord();
      if (c === ";") {
        statements.push([]);
      }
      i += 1;
    } else {
      return undefined;
    }
  }
  endWord();
  return statements;
};

/** The env an `export NAME=value …` statement sets, or undefined. */
const exportedEnv = (
  statement: readonly string[],
): Record<string, string> | undefined => {
  const [keyword, ...assignments] = statement;
  if (keyword !== "export" || assignments.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    const name = assignment.slice(0, eq);
    if (eq === -1 || !ENV_NAME.test(name)) {
      return undefined;
    }
    env[name] = assignment.slice(eq + 1);
  }
  return env;
};

/**
 * Split a POSIX shell command into argv, when it is a simple command.
 *
 * Understands exactly what Sandcastle produces: bare words, `'single'`
 * quotes, `"double"` quotes with POSIX backslash escapes, the `\'` that
 * `shellEscape` emits between quoted runs, and leading `export NAME=value;`
 * statements (the agent env prefix from `createSandbox`). Returns undefined
 * for anything else.
 */
export const parseSimpleCommand = (
  command: string,
): SimpleCommand | undefined => {
  const statements = splitStatements(command);
  const argv = statements?.pop();
  const [program] = argv ?? [];
  if (
    statements === undefined ||
    argv === undefined ||
    program === undefined ||
    program === "" ||
    program.includes("=")
  ) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const statement of statements) {
    const exported = exportedEnv(statement);
    if (exported === undefined) {
      return undefined;
    }
    Object.assign(env, exported);
  }
  return { env, argv };
};
