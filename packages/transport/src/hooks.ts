import { useContext } from "react";
import {
  TransportContext,
  type TransportContextValue,
} from "./TransportProvider.js";
import type { ApiClient } from "./apiClient.js";
import type { FleetSocketConnector } from "./ws.js";

/**
 * Returns the active `TransportContextValue`. Throws when called outside a
 * `<TransportProvider>` — the only valid call site for any sandcastle
 * renderer is inside that provider.
 */
export const useTransport = (): TransportContextValue => {
  const value = useContext(TransportContext);
  if (!value) {
    throw new Error(
      "useTransport must be used inside a <TransportProvider>. Wrap the React root with one and pass a SandcastleConnection.",
    );
  }
  return value;
};

/**
 * Direct accessor for the transport-bound api client. Equivalent to
 * `useTransport().apiClient` — exposed as a separate hook so renderers
 * don't need to memoize on the whole context value.
 */
export const useApiClient = (): ApiClient => useTransport().apiClient;

/**
 * Direct accessor for the fleet-socket connector. Equivalent to
 * `useTransport().connectFleetSocket`.
 */
export const useFleetSocket = (): FleetSocketConnector =>
  useTransport().connectFleetSocket;
