import { describe, expect, it, vi } from "vitest";
import { apiClient } from "../src/apiClient.js";

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("apiClient factory", () => {
  it("attaches bearer token, prefixes baseUrl, and parses fleet response", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://hosted.example.com/fleet");
      expect((init?.headers as Record<string, string>)["authorization"]).toBe(
        "Bearer secret",
      );
      return okResponse({
        capacity: { used: 0, max: 1 },
        runsById: {},
        planetsById: {},
        operativesById: {},
        phasesById: {},
        dockOrder: [],
        pendingDecisions: [],
        updatedAt: new Date().toISOString(),
      });
    });
    const client = apiClient(
      { baseUrl: "https://hosted.example.com", token: "secret" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    const fleet = await client.getFleet();
    expect(fleet.capacity).toEqual({ used: 0, max: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws with the server error string when status is not ok", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = apiClient(
      { baseUrl: "http://127.0.0.1:1234", token: "x" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await expect(client.getFleet()).rejects.toThrow(/nope/);
  });

  it("encodes path parameters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/runs/run%2F1/cancel");
      return okResponse({ runId: "run/1", cancelled: true });
    });
    const client = apiClient(
      { baseUrl: "http://x", token: "t" },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await client.cancelRun("run/1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
