import { ExecFailedError } from "./ExecFailedError.js";
import { redactor } from "./redaction.js";

// What a failed command's error says: its exit code and command, then the
// tail of its stderr, so the message alone says why it failed. The tail is
// bounded, and every env value the command ran with is masked in it first,
// as a session record masks its secrets.

/** How many of stderr's last non-blank lines the message keeps. */
const TAIL_LINES = 20;
/** How many of stderr's last characters the message keeps, at most. */
const TAIL_CHARS = 2000;

/** The last non-blank lines of `text`, at most `TAIL_CHARS` of them. */
export const outputTail = (text: string): string => {
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");
  return lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines;
};

/**
 * The message for a command that exited non-zero: `stderr`'s tail with every
 * value in `env` masked (the sandbox's env and the command's own).
 */
const execFailedMessage = (failed: {
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly env: Readonly<Record<string, string>>;
}): string => {
  const redact = redactor(
    { values: Object.values(failed.env), envVars: [] },
    {},
  );
  // Masked before it's cut, so the cut can't split a secret and leave half.
  const tail = outputTail(redact(failed.stderr));
  const head = `Command exited with code ${failed.exitCode}: ${failed.command}`;
  return tail === "" ? head : `${head}\n${tail}`;
};

/** The `ExecFailedError` for a command that exited non-zero, its message saying why. */
export const execFailed = (failed: {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly env: Readonly<Record<string, string>>;
}): ExecFailedError =>
  new ExecFailedError({
    message: execFailedMessage(failed),
    command: failed.command,
    exitCode: failed.exitCode,
    stdout: failed.stdout,
    stderr: failed.stderr,
  });
