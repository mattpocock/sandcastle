import { createContext, useMemo, type JSX, type ReactNode } from "react";
import { apiClient as createApiClient, type ApiClient } from "./apiClient.js";
import {
  connectFleetSocket,
  type FleetSocketConnector,
  type ServerMessageHandler,
} from "./ws.js";
import type { SandcastleConnection } from "./SandcastleConnection.js";

export interface TransportContextValue {
  readonly connection: SandcastleConnection;
  readonly apiClient: ApiClient;
  readonly connectFleetSocket: FleetSocketConnector;
}

export const TransportContext = createContext<TransportContextValue | null>(
  null,
);

export interface TransportProviderProps {
  readonly connection: SandcastleConnection;
  readonly children: ReactNode;
  /**
   * Test-only hook for injecting a mock api client. When provided, this
   * factory is used instead of the default `createApiClient`. Production
   * callers should never need this.
   */
  readonly apiClientFactory?: (connection: SandcastleConnection) => ApiClient;
}

/**
 * React context provider that hands a transport-bound api client + ws
 * connector to descendants. Re-derives lazily when the connection
 * (`baseUrl` + `token`) changes — both of which the supervisor or
 * web-shell can hot-swap.
 */
export function TransportProvider(props: TransportProviderProps): JSX.Element {
  const { connection, children, apiClientFactory } = props;

  const value = useMemo<TransportContextValue>(() => {
    const factory = apiClientFactory ?? createApiClient;
    const client = factory(connection);
    const connector: FleetSocketConnector = (handler: ServerMessageHandler) =>
      connectFleetSocket(connection, handler);
    return {
      connection,
      apiClient: client,
      connectFleetSocket: connector,
    };
    // `apiClientFactory` is opt-in test glue; treating it as stable keeps
    // production renders cheap while still letting tests swap clients.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.baseUrl, connection.token]);

  return (
    <TransportContext.Provider value={value}>
      {children}
    </TransportContext.Provider>
  );
}
