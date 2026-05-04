import { WebSocketServer, type WebSocket } from "ws";
import { nanoid } from "nanoid";
import type {
  FleetState,
  RunEvent,
  WsClientMessage,
  WsServerMessage,
} from "@sandcastle/protocol";
import { zWsClientMessage } from "@sandcastle/protocol";

interface ClientState {
  readonly ws: WebSocket;
  runId?: string;
}

export interface WsHubOptions {
  readonly getFleetSnapshot: () => Promise<FleetState>;
  readonly serverVersion?: string;
}

export class WsHub {
  readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<ClientState>();
  private readonly textQueues = new Map<
    string,
    {
      message: string;
      event: RunEvent & { type: "text" };
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly options: WsHubOptions) {
    this.wss.on("connection", (ws) => {
      const client: ClientState = { ws };
      this.clients.add(client);
      this.send(ws, {
        type: "hello",
        payload: {
          sessionId: nanoid(),
          serverVersion: options.serverVersion ?? "0.0.0",
        },
      });
      void options.getFleetSnapshot().then((snapshot) => {
        if (ws.readyState === ws.OPEN) {
          this.send(ws, { type: "fleet.snapshot", payload: snapshot });
        }
      });

      ws.on("message", (data) =>
        this.handleClientMessage(client, data.toString()),
      );
      ws.on("close", () => this.clients.delete(client));
    });
  }

  publish(runId: string, event: RunEvent): void {
    if (event.type === "text") {
      this.enqueueText(runId, event);
      return;
    }
    if (isCritical(event)) this.flushText(runId);
    this.broadcast({ type: "run.event", runId, event });
  }

  close(): void {
    for (const runId of [...this.textQueues.keys()]) this.flushText(runId);
    this.wss.close();
  }

  private handleClientMessage(client: ClientState, raw: string): void {
    let parsed: WsClientMessage;
    try {
      parsed = zWsClientMessage.parse(JSON.parse(raw));
    } catch {
      this.send(client.ws, {
        type: "error",
        payload: {
          code: "BAD_MESSAGE",
          message: "Malformed WebSocket message",
        },
      });
      return;
    }

    if (parsed.type === "subscribe") {
      client.runId = parsed.payload.runId;
      return;
    }

    if (parsed.type === "ping") {
      this.send(client.ws, {
        type: "hello",
        payload: {
          sessionId: nanoid(),
          serverVersion: this.options.serverVersion ?? "0.0.0",
        },
      });
    }
  }

  private enqueueText(runId: string, event: RunEvent & { type: "text" }): void {
    const existing = this.textQueues.get(runId);
    if (existing) {
      existing.message += event.message;
      return;
    }
    const entry = {
      message: event.message,
      event,
      timer: setTimeout(() => this.flushText(runId), 33),
    };
    this.textQueues.set(runId, entry);
  }

  private flushText(runId: string): void {
    const queued = this.textQueues.get(runId);
    if (!queued) return;
    clearTimeout(queued.timer);
    this.textQueues.delete(runId);
    this.broadcast({
      type: "run.event",
      runId,
      event: {
        ...queued.event,
        message: queued.message,
        timestamp: new Date(),
      },
    });
  }

  private broadcast(message: WsServerMessage): void {
    for (const client of this.clients) {
      if (
        message.type === "run.event" &&
        client.runId &&
        client.runId !== message.runId
      )
        continue;
      this.send(client.ws, message);
    }
  }

  private send(ws: WebSocket, message: WsServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
}

const isCritical = (event: RunEvent): boolean =>
  event.type === "run.statusChanged" ||
  event.type === "verification.finished" ||
  event.type === "run.resolved";
