/**
 * How full an iteration's context window was: the input side of its LAST
 * model call, cache reads and cache writes included (see ADR 0023).
 *
 * Each model call's input already holds the whole conversation so far, so the
 * last call is the context size. Never sum calls, and never use a total the
 * agent reports for a turn or a session: those grow with every tool
 * round-trip and can exceed the window.
 */
export interface ContextWindow {
  /** Input tokens of the last model call, cached and uncached together. */
  readonly tokens: number;
  /** The model's context window size, only when the agent itself reports it. */
  readonly limit?: number;
}

/**
 * Format a context window as `47k`, or `32k / 258k` when the limit is known.
 * Tokens round up (never understate use); the limit rounds down (never
 * overstate room).
 */
export const formatContextWindow = (contextWindow: ContextWindow): string => {
  const used = `${Math.ceil(contextWindow.tokens / 1000)}k`;
  return contextWindow.limit === undefined
    ? used
    : `${used} / ${Math.floor(contextWindow.limit / 1000)}k`;
};

/**
 * Build `Context window: NNNk` lines, one per iteration that has a context
 * window. Iterations without one (e.g. cursor, which reports no per-call
 * figure) are skipped.
 */
export const buildContextWindowLines = (
  iterations: readonly { readonly contextWindow?: ContextWindow }[],
): string[] =>
  iterations.flatMap((it) =>
    it.contextWindow
      ? [`Context window: ${formatContextWindow(it.contextWindow)}`]
      : [],
  );
