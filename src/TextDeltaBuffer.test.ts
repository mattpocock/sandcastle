import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";

describe("TextDeltaBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes on newline character", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello world\n");
    expect(flushed).toStrictEqual(["Hello world\n"]);
  });

  it("flushes on sentence boundary (period + space)", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello. ");
    expect(flushed).toStrictEqual(["Hello. "]);
  });

  it("flushes on sentence boundary (exclamation + space)", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello! ");
    expect(flushed).toStrictEqual(["Hello! "]);
  });

  it("flushes on sentence boundary (question + space)", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello? ");
    expect(flushed).toStrictEqual(["Hello? "]);
  });

  it("flushes when buffer exceeds length threshold", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    // Write 90 chars without any sentence boundary or newline
    const chunk = "a".repeat(90);
    buf.write(chunk);
    expect(flushed).toStrictEqual([chunk]);
  });

  it("accumulates small chunks and flushes on debounce timeout", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello");
    expect(flushed).toStrictEqual([]);

    buf.write(" world");
    expect(flushed).toStrictEqual([]);

    vi.advanceTimersByTime(50);
    expect(flushed).toStrictEqual(["Hello world"]);
  });

  it("resets debounce timer on new write", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello");
    vi.advanceTimersByTime(30);
    buf.write(" world");
    vi.advanceTimersByTime(30);
    // Only 30ms since last write, shouldn't flush yet
    expect(flushed).toStrictEqual([]);

    vi.advanceTimersByTime(20);
    // Now 50ms since last write
    expect(flushed).toStrictEqual(["Hello world"]);
  });

  it("force-flushes remaining buffer via flush()", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("trailing");
    expect(flushed).toStrictEqual([]);

    buf.flush();
    expect(flushed).toStrictEqual(["trailing"]);
  });

  it("flush() is a no-op when buffer is empty", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.flush();
    expect(flushed).toStrictEqual([]);
  });

  it("flushes multiple chunks as they accumulate across boundaries", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("First sentence. ");
    buf.write("Second");
    buf.write(" sentence.\n");

    expect(flushed).toStrictEqual(["First sentence. ", "Second sentence.\n"]);
  });

  it("does not double-flush when newline and sentence boundary overlap", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Done.\n");
    expect(flushed).toStrictEqual(["Done.\n"]);
  });

  it("handles sentence-ending punctuation at end of buffer without trailing space", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("End.");
    // No trailing space, so sentence heuristic doesn't fire
    expect(flushed).toStrictEqual([]);

    // But debounce catches it
    vi.advanceTimersByTime(50);
    expect(flushed).toStrictEqual(["End."]);
  });

  it("clears debounce timer on explicit flush", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello");
    buf.flush();
    expect(flushed).toStrictEqual(["Hello"]);

    // Debounce timer should not double-flush
    vi.advanceTimersByTime(100);
    expect(flushed).toStrictEqual(["Hello"]);
  });

  it("clears debounce timer on boundary flush", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("Hello.\n");
    expect(flushed).toStrictEqual(["Hello.\n"]);

    // Debounce timer should not double-flush
    vi.advanceTimersByTime(100);
    expect(flushed).toStrictEqual(["Hello.\n"]);
  });

  it("handles empty writes gracefully", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("");
    expect(flushed).toStrictEqual([]);
    vi.advanceTimersByTime(100);
    expect(flushed).toStrictEqual([]);
  });

  it("dispose() flushes remaining buffer and cancels timer", () => {
    const flushed: string[] = [];
    const buf = new TextDeltaBuffer((text) => {
      flushed.push(text);
    });

    buf.write("leftover");
    buf.dispose();
    expect(flushed).toStrictEqual(["leftover"]);

    // No further flushes after dispose
    vi.advanceTimersByTime(100);
    expect(flushed).toStrictEqual(["leftover"]);
  });
});
