/**
 * Terminal cleanup for abrupt exits.
 *
 * @clack/prompts' spinner and taskLog call stdin.setRawMode(true) and hide
 * the cursor via escape sequences. When the process is killed by a signal
 * handler that calls process.exit() directly (e.g. during Ctrl-C cleanup in
 * SandboxFactory), clack's own cleanup is bypassed and the terminal is left
 * in raw mode with the cursor hidden.
 *
 * Registering a process 'exit' listener that restores these guarantees the
 * terminal is always left in a usable state.
 */

/** Escape sequence to show the cursor (DECTCEM). */
export const SHOW_CURSOR = "\u001B[?25h";

/**
 * Creates a synchronous exit handler that restores terminal state.
 * Extracted as a pure function so it can be unit-tested without side effects.
 */
export const makeTerminalCleanupHandler =
  (
    stdin: { isTTY?: boolean; setRawMode?: (raw: boolean) => void },
    stdout: { write: (data: string) => boolean },
  ) =>
  (): void => {
    if (stdin.isTTY === true && stdin.setRawMode !== undefined) {
      try {
        stdin.setRawMode(false);
      } catch {
        // Best-effort — may fail if stdin is already closed
      }
    }
    stdout.write(SHOW_CURSOR);
  };

/**
 * Registers the terminal cleanup handler on process 'exit'.
 * Call once at program startup (main.ts).
 */
export const setupTerminalCleanup = (): void => {
  process.on("exit", makeTerminalCleanupHandler(process.stdin, process.stdout));
};
