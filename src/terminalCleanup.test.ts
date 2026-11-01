import { describe, expect, it, vi } from "vitest";
import { SHOW_CURSOR, makeTerminalCleanupHandler } from "./terminalCleanup.js";

type SetRawMode = (raw: boolean) => void;
type Write = (data: string) => boolean;

describe("makeTerminalCleanupHandler", () => {
  it("calls setRawMode(false) and writes show-cursor when stdin is a TTY", () => {
    const setRawMode = vi.fn<SetRawMode>();
    const write = vi.fn<Write>(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true, setRawMode },
      { write },
    );
    handler();

    expect(setRawMode).toHaveBeenCalledExactlyOnceWith(false);
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("skips setRawMode when stdin is not a TTY", () => {
    const setRawMode = vi.fn<SetRawMode>();
    const write = vi.fn<Write>(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: false, setRawMode },
      { write },
    );
    handler();

    expect(setRawMode).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("skips setRawMode when stdin has no setRawMode (non-TTY pipe)", () => {
    const write = vi.fn<Write>(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true }, // isTTY true but no setRawMode
      { write },
    );
    handler();

    // No error thrown, cursor still shown
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it("does not throw when setRawMode throws", () => {
    const setRawMode = vi.fn<SetRawMode>(() => {
      throw new Error("setRawMode failed");
    });
    const write = vi.fn<Write>(() => true);

    const handler = makeTerminalCleanupHandler(
      { isTTY: true, setRawMode },
      { write },
    );

    expect(handler).not.toThrow();
    // cursor is still shown even after setRawMode failure
    expect(write).toHaveBeenCalledWith(SHOW_CURSOR);
  });
});
