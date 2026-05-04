import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  TransportProvider,
  useApiClient,
  useFleetSocket,
  useTransport,
} from "../src/index.js";
import type { ApiClient } from "../src/apiClient.js";

const stubClient: ApiClient = {
  getFleet: async () => ({}) as never,
  getRepo: async () => ({}) as never,
  getRun: async () => ({}) as never,
  createRun: async () => ({}) as never,
  cancelRun: async () => ({}) as never,
  decideRun: async () => ({}) as never,
  parseQuestForge: async () => ({}) as never,
  engageQuestForge: async () => ({}) as never,
  mergeAllGreen: async () => ({}) as never,
  getRepos: async () => ({}) as never,
  getRepoDeck: async () => ({}) as never,
  getRepoTelemetry: async () => ({}) as never,
  getOperatives: async () => ({}) as never,
  getOperative: async () => ({}) as never,
  getActivity: async () => ({}) as never,
  getOperativeXp: async () => ({}) as never,
};

function Probe(): JSX.Element {
  const { connection } = useTransport();
  const client = useApiClient();
  const connectFleetSocket = useFleetSocket();
  return (
    <div>
      <span data-testid="base">{connection.baseUrl}</span>
      <span data-testid="token">{connection.token}</span>
      <span data-testid="client-is-stub">
        {client === stubClient ? "y" : "n"}
      </span>
      <span data-testid="connector-type">{typeof connectFleetSocket}</span>
    </div>
  );
}

describe("TransportProvider", () => {
  it("provides connection + apiClient + ws connector to descendants", () => {
    render(
      <TransportProvider
        connection={{ baseUrl: "https://hosted.example.com", token: "abc" }}
        apiClientFactory={() => stubClient}
      >
        <Probe />
      </TransportProvider>,
    );

    expect(screen.getByTestId("base").textContent).toBe(
      "https://hosted.example.com",
    );
    expect(screen.getByTestId("token").textContent).toBe("abc");
    expect(screen.getByTestId("client-is-stub").textContent).toBe("y");
    expect(screen.getByTestId("connector-type").textContent).toBe("function");
  });

  it("throws when useTransport is called outside the provider", () => {
    // Render swallows the throw and surfaces it via the error boundary path;
    // the simplest assertion is to call the hook directly through React.
    const broken = (): unknown => {
      const Boom = (): JSX.Element => {
        useTransport();
        return <div />;
      };
      // Suppress the React-injected error log so the suite stays quiet.
      const originalError = console.error;
      console.error = () => {};
      try {
        render(<Boom />);
      } finally {
        console.error = originalError;
      }
      return null;
    };
    expect(broken).toThrow(/useTransport/);
  });
});
