import {
  zWsServerMessage,
  type WsClientMessage,
  type WsServerMessage,
} from "@sandcastle/protocol";
import {
  wsBaseUrl,
  type SandcastleConnection,
} from "./SandcastleConnection.js";

export type ServerMessageHandler = (message: WsServerMessage) => void;

/**
 * Open a WebSocket against the connection's base URL with reconnect
 * backoff. Returns a disposer.
 *
 * Mirrors the desktop renderer's previous `connectFleetSocket` exactly,
 * except `connection.port` has been replaced by `connection.baseUrl`
 * (so this works for `wss://hosted.example.com` just as well as
 * `ws://127.0.0.1:NNNN`).
 */
export const connectFleetSocket = (
  connection: SandcastleConnection,
  onMessage: ServerMessageHandler,
): (() => void) => {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (message: WsClientMessage): void => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };

  const open = (): void => {
    socket = new WebSocket(
      `${wsBaseUrl(connection.baseUrl)}/?token=${encodeURIComponent(
        connection.token,
      )}`,
    );

    socket.addEventListener("open", () => {
      retry = 0;
      send({ type: "subscribe", payload: {} });
    });

    socket.addEventListener("message", (event) => {
      try {
        onMessage(zWsServerMessage.parse(JSON.parse(String(event.data))));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[sandcastle-transport] malformed WS message", error);
      }
    });

    socket.addEventListener("close", () => {
      if (disposed) return;
      retry += 1;
      const delay = Math.min(10_000, 350 * 2 ** retry);
      retryTimer = setTimeout(open, delay);
    });

    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  open();

  return () => {
    disposed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    socket?.close();
  };
};

export type FleetSocketConnector = (
  onMessage: ServerMessageHandler,
) => () => void;
