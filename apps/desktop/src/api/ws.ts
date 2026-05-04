import {
  zWsServerMessage,
  type WsClientMessage,
  type WsServerMessage,
} from "@sandcastle/protocol";
import type { SandcastleConnection } from "./client";

export type ServerMessageHandler = (message: WsServerMessage) => void;

export const connectFleetSocket = (
  connection: SandcastleConnection,
  onMessage: ServerMessageHandler,
): (() => void) => {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry = 0;
  let retryTimer: number | undefined;

  const send = (message: WsClientMessage): void => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };

  const open = (): void => {
    socket = new WebSocket(
      `ws://127.0.0.1:${connection.port}/?token=${encodeURIComponent(connection.token)}`,
    );

    socket.addEventListener("open", () => {
      retry = 0;
      send({ type: "subscribe", payload: {} });
    });

    socket.addEventListener("message", (event) => {
      try {
        onMessage(zWsServerMessage.parse(JSON.parse(String(event.data))));
      } catch (error) {
        console.error("[sandcastle-ui] malformed WS message", error);
      }
    });

    socket.addEventListener("close", () => {
      if (disposed) return;
      retry += 1;
      const delay = Math.min(10_000, 350 * 2 ** retry);
      retryTimer = window.setTimeout(open, delay);
    });

    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  open();

  return () => {
    disposed = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    socket?.close();
  };
};
