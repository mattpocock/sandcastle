import { describe, expect, it } from "vitest";
import { BoundedTail, MAX_TAIL_CHARS } from "./boundedTail.js";

describe("BoundedTail", () => {
  it("returns an empty string when nothing was pushed", () => {
    const tail = new BoundedTail(100);
    expect(tail.toString()).toBe("");
  });

  it("retains everything while under budget", () => {
    const tail = new BoundedTail(100, "\n");
    tail.push("alpha");
    tail.push("beta");
    expect(tail.toString()).toBe("alpha\nbeta");
  });

  it("drops the oldest items once the joined length exceeds the budget", () => {
    const tail = new BoundedTail(10, "\n");
    tail.push("aaaa"); // 4
    tail.push("bbbb"); // 4 -> "aaaa\nbbbb" = 9
    tail.push("cccc"); // would be 14 -> drop "aaaa"

    expect(tail.toString()).toBe("bbbb\ncccc");
    expect(tail.toString().length).toBeLessThanOrEqual(10);
  });

  it("never grows beyond the budget across many pushes", () => {
    const tail = new BoundedTail(50, "\n");
    for (let i = 0; i < 10_000; i++) {
      tail.push(`line-${i}`);
    }
    expect(tail.toString().length).toBeLessThanOrEqual(50);
    // The most recent line must still be present.
    expect(tail.toString()).toContain("line-9999");
  });

  it("truncates a single oversized item to its tail", () => {
    const tail = new BoundedTail(10, "\n");
    tail.push("0123456789ABCDEF"); // 16 chars, no newline
    expect(tail.toString()).toBe("6789ABCDEF");
    expect(tail.toString()).toHaveLength(10);
  });

  it("keeps the tail of an oversized item even when earlier items exist", () => {
    const tail = new BoundedTail(10, "\n");
    tail.push("hello");
    tail.push("X".repeat(100));
    expect(tail.toString()).toBe("X".repeat(10));
  });

  it("defaults to concatenation with no separator", () => {
    const tail = new BoundedTail(100);
    tail.push("ab");
    tail.push("cd");
    expect(tail.toString()).toBe("abcd");
  });

  it("exposes a sane default budget", () => {
    expect(MAX_TAIL_CHARS).toBe(64 * 1024);
  });
});
