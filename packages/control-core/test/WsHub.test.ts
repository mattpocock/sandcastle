import { createServer } from "node:http";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { WsHub } from "../src/ws/WsHub.js";
import type { FleetState, WsServerMessage } from "@sandcastle/protocol";

const fleet: FleetState = {
  planetsById: {},
  operativesById: {},
  runsById: {},
  phasesById: {},
  dockOrder: [],
  pendingDecisions: [],
  capacity: { used: 0, max: 1 },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const withHub = async (
  test: (hub: WsHub, url: string) => Promise<void>,
): Promise<void> => {
  const hub = new WsHub({ getFleetSnapshot: async () => fleet });
  const server = createServer();
  server.on("upgrade", (req, socket, head) =>
    hub.wss.handleUpgrade(req, socket, head, (ws) =>
      hub.wss.emit("connection", ws, req),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  try {
    await test(hub, `ws://127.0.0.1:${address.port}`);
  } finally {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

const collect = (ws: WebSocket): WsServerMessage[] => {
  const messages: WsServerMessage[] = [];
  ws.on("message", (data) =>
    messages.push(JSON.parse(data.toString()) as WsServerMessage),
  );
  return messages;
};

const waitForMessages = async (
  messages: WsServerMessage[],
  count: number,
): Promise<void> => {
  const start = Date.now();
  while (messages.length < count) {
    if (Date.now() - start > 3000)
      throw new Error(`Timed out waiting for ${count} messages`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("WsHub", () => {
  it("connects, subscribes, and receives events", async () => {
    await withHub(async (hub, url) => {
      const ws = new WebSocket(url);
      const messages = collect(ws);
      await new Promise<void>((resolve) => ws.once("open", resolve));
      await waitForMessages(messages, 2);
      ws.send(
        JSON.stringify({ type: "subscribe", payload: { runId: "run_123" } }),
      );
      hub.publish("run_123", {
        type: "run.resolved",
        runId: "run_123",
        result: "victory",
        xpDelta: 0,
        iteration: 1,
        timestamp: new Date(),
      });
      await waitForMessages(messages, 3);
      expect(messages[0]?.type).toBe("hello");
      expect(messages[1]?.type).toBe("fleet.snapshot");
      expect(messages[2]?.type).toBe("run.event");
      ws.close();
    });
  });

  it("coalesces text deltas within a 33ms window", async () => {
    await withHub(async (hub, url) => {
      const ws = new WebSocket(url);
      const messages = collect(ws);
      await new Promise<void>((resolve) => ws.once("open", resolve));
      await waitForMessages(messages, 2);
      hub.publish("run_123", {
        type: "text",
        message: "hello ",
        iteration: 1,
        timestamp: new Date(),
      });
      hub.publish("run_123", {
        type: "text",
        message: "world",
        iteration: 1,
        timestamp: new Date(),
      });
      await waitForMessages(messages, 3);
      const eventMessage = messages.find(
        (message) => message.type === "run.event",
      );
      expect(eventMessage?.type).toBe("run.event");
      if (eventMessage?.type === "run.event")
        expect(eventMessage.event).toMatchObject({
          type: "text",
          message: "hello world",
        });
      ws.close();
    });
  });

  it("flushes critical events immediately", async () => {
    await withHub(async (hub, url) => {
      const ws = new WebSocket(url);
      const messages = collect(ws);
      await new Promise<void>((resolve) => ws.once("open", resolve));
      await waitForMessages(messages, 2);
      hub.publish("run_123", {
        type: "text",
        message: "pending",
        iteration: 1,
        timestamp: new Date(),
      });
      hub.publish("run_123", {
        type: "run.resolved",
        runId: "run_123",
        result: "aborted",
        xpDelta: 0,
        iteration: 1,
        timestamp: new Date(),
      });
      await waitForMessages(messages, 4);
      expect(messages.slice(2).map((message) => message.type)).toEqual([
        "run.event",
        "run.event",
      ]);
      ws.close();
    });
  });
});
