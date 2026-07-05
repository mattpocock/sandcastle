import { describe, expect, it, vi } from "vitest";
import { SHOW_CURSOR, makeTerminalCleanupHandler } from "./terminalCleanup.js";

describe("makeTerminalCleanupHandler", () => {
  it("calls setRawMode(false) and writes show-cursor when stdin is a TTY", () => {
    const setRawMode = vi.fn();
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true, setRawMode },
      { isTTY: true, write },
    );
    handler();

    expect(setRawMode).toHaveBeenCalledOnce();
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("skips setRawMode when stdin is not a TTY but still restores cursor on TTY stdout", () => {
    const setRawMode = vi.fn();
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: false, setRawMode },
      { isTTY: true, write },
    );
    handler();

    expect(setRawMode).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("skips setRawMode when stdin has no setRawMode", () => {
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true }, // isTTY true but no setRawMode
      { isTTY: true, write },
    );
    handler();

    // No error thrown, cursor still shown
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("does not throw when setRawMode throws", () => {
    const setRawMode = vi.fn(() => {
      throw new Error("setRawMode failed");
    });
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true, setRawMode },
      { isTTY: true, write },
    );

    expect(() => handler()).not.toThrow();
    // cursor is still shown even after setRawMode failure
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("does not write show-cursor escapes to piped stdout", () => {
    const write = vi.fn(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: false },
      { isTTY: false, write },
    );
    handler();

    expect(write).not.toHaveBeenCalled();
  });
});
