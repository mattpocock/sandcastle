/**
 * Transport-neutral handle to a control-core server.
 *
 * `baseUrl` is a fully-qualified URL — `http://127.0.0.1:NNNN` for the
 * Electron supervisor, `https://hosted.example.com` for the hosted-web build.
 * The transport package never assumes localhost.
 */
export interface SandcastleConnection {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Returns the WebSocket scheme that pairs with a given base URL —
 * `http://` → `ws://`, `https://` → `wss://`. Falls back to `ws://`
 * for non-HTTP schemes (defensive — the dispatcher should never pass
 * one, but we don't want to throw at runtime).
 */
export const wsBaseUrl = (baseUrl: string): string => {
  if (baseUrl.startsWith("https://"))
    return `wss://${baseUrl.slice("https://".length)}`;
  if (baseUrl.startsWith("http://"))
    return `ws://${baseUrl.slice("http://".length)}`;
  return baseUrl;
};
