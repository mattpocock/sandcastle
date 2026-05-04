import { describe, expect, it } from "vitest";
import { generateToken } from "../../src/auth/token.js";
import { startServer } from "../../src/server.js";
import { makeRepo } from "../helpers.js";

describe("token auth", () => {
  it("generates URL-safe 32-byte tokens", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("rejects HTTP requests without bearer auth", async () => {
    const repo = makeRepo();
    const server = await startServer({ repo, token: "secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/fleet`);
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
