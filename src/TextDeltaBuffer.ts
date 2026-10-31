const LENGTH_THRESHOLD = 80;
const DEBOUNCE_MS = 50;

/**
 * Sentence-boundary pattern: period, exclamation, or question mark followed by a space.
 */
const SENTENCE_BOUNDARY_RE = /[.!?] $/;

/**
 * Buffers streaming text deltas and flushes them as readable multi-word chunks.
 *
 * Flush triggers:
 * - Newline character in the accumulated buffer
 * - Sentence boundary (`. `, `! `, `? ` at end of buffer)
 * - Buffer exceeds ~80 characters
 * - Debounce timer (~50ms of no new writes)
 */
export class TextDeltaBuffer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onFlush: (text: string) => void;

  constructor(onFlush: (text: string) => void) {
    this.onFlush = onFlush;
  }

  write(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.buffer += text;
    this.clearTimer();

    if (this.shouldFlush()) {
      this.doFlush();
      return;
    }

    this.timer = setTimeout(() => {
      this.doFlush();
    }, DEBOUNCE_MS);
  }

  /** Force-flush any buffered text. */
  flush(): void {
    this.clearTimer();
    this.doFlush();
  }

  /** Flush remaining buffer and clean up. */
  dispose(): void {
    this.flush();
  }

  private shouldFlush(): boolean {
    if (this.buffer.includes("\n")) {
      return true;
    }
    if (SENTENCE_BOUNDARY_RE.test(this.buffer)) {
      return true;
    }
    if (this.buffer.length >= LENGTH_THRESHOLD) {
      return true;
    }
    return false;
  }

  private doFlush(): void {
    if (this.buffer.length === 0) {
      return;
    }
    const text = this.buffer;
    this.buffer = "";
    this.onFlush(text);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
