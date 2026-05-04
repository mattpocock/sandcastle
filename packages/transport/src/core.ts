/**
 * No-React subset of the transport package — exports the api client + ws
 * factories and the connection type. Useful for node-side tests (parity
 * suites, harnesses) that need to talk to a real control-core without
 * pulling React into the runtime.
 */
export type { SandcastleConnection } from "./SandcastleConnection.js";
export { wsBaseUrl } from "./SandcastleConnection.js";

export { apiClient } from "./apiClient.js";
export type { ApiClient, ApiClientOptions } from "./apiClient.js";

export { connectFleetSocket } from "./ws.js";
export type { FleetSocketConnector, ServerMessageHandler } from "./ws.js";
