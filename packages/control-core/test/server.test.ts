import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";
import { RunSupervisor } from "../src/runs/RunSupervisor.js";
import { SqliteStore } from "../src/telemetry/SqliteStore.js";
import { fakeAgent, makeRepo, waitFor } from "./helpers.js";
import type { WsServerMessage } from "@sandcastle/protocol";

describe("server", () => {
  it("boots, serves HTTP routes, starts runs, and streams WS events", async () => {
    const repo = makeRepo();
    const store = new SqliteStore(repo);
    const runSupervisor = new RunSupervisor({
      repoRoot: repo,
      store,
      agentFactory: () => fakeAgent(),
    });
    const server = await startServer({
      repo,
      token: "secret",
      runSupervisor,
      store,
    });
    const auth = { authorization: "Bearer secret" };
    try {
      const fleetResponse = await fetch(
        `http://127.0.0.1:${server.port}/fleet`,
        { headers: auth },
      );
      expect(fleetResponse.status).toBe(200);
      const fleet = await fleetResponse.json();
      expect(fleet).toMatchObject({ capacity: { used: 0, max: 1 } });

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=secret`);
      const messages: WsServerMessage[] = [];
      ws.on("message", (data) =>
        messages.push(JSON.parse(data.toString()) as WsServerMessage),
      );
      await new Promise<void>((resolve) => ws.once("open", resolve));

      const runResponse = await fetch(`http://127.0.0.1:${server.port}/runs`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ directive: "do it" }),
      });
      expect(runResponse.status).toBe(200);
      const { runId } = (await runResponse.json()) as { runId: string };
      ws.send(JSON.stringify({ type: "subscribe", payload: { runId } }));

      await waitFor(() =>
        messages.some((message) => message.type === "run.event"),
      );
      const runSnapshot = await fetch(
        `http://127.0.0.1:${server.port}/runs/${runId}`,
        { headers: auth },
      );
      expect(runSnapshot.status).toBe(200);
      expect(await runSnapshot.json()).toMatchObject({ id: runId });
      ws.close();
    } finally {
      await server.close();
    }
  }, 10000);

  it("rejects WS handshakes without the token", async () => {
    const repo = makeRepo();
    const server = await startServer({ repo, token: "secret" });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
      await expect(
        new Promise((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
