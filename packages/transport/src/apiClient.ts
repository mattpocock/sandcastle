import {
  zGetActivityResponse,
  zGetFleetResponse,
  zGetOperativeResponse,
  zGetOperativeXpResponse,
  zGetOperativesResponse,
  zGetRepoDeckResponse,
  zGetRepoResponse,
  zGetRepoTelemetryResponse,
  zGetReposResponse,
  zGetRunResponse,
  zPostMergeAllGreenResponse,
  zPostQuestForgeEngageResponse,
  zPostQuestForgeParseResponse,
  zPostRunCancelResponse,
  zPostRunDecisionResponse,
  zPostRunsResponse,
  type GetActivityResponse,
  type GetFleetResponse,
  type GetOperativeResponse,
  type GetOperativeXpResponse,
  type GetOperativesResponse,
  type GetRepoDeckResponse,
  type GetRepoResponse,
  type GetRepoTelemetryResponse,
  type GetReposResponse,
  type GetRunResponse,
  type PostMergeAllGreenResponse,
  type PostQuestForgeEngageRequest,
  type PostQuestForgeEngageResponse,
  type PostQuestForgeParseResponse,
  type PostRunsRequest,
  type PostRunsResponse,
  type PostRunCancelResponse,
  type PostRunDecisionResponse,
  type RunDecisionKind,
} from "@sandcastle/protocol";
import type { SandcastleConnection } from "./SandcastleConnection.js";

/**
 * Optional override hook — primarily for tests that want to inject a custom
 * `fetch`. Production code uses the global `fetch`.
 */
export interface ApiClientOptions {
  readonly fetch?: typeof fetch;
}

/**
 * Public surface of the api client. Keep this in lock-step with the
 * shape exported by `apps/desktop/src/api/client.ts` so the desktop
 * migration is a drop-in swap.
 */
export interface ApiClient {
  getFleet(): Promise<GetFleetResponse>;
  getRepo(): Promise<GetRepoResponse>;
  getRun(runId: string): Promise<GetRunResponse>;
  createRun(request: PostRunsRequest): Promise<PostRunsResponse>;
  cancelRun(runId: string): Promise<PostRunCancelResponse>;
  decideRun(
    runId: string,
    kind: RunDecisionKind,
  ): Promise<PostRunDecisionResponse>;
  parseQuestForge(directive: string): Promise<PostQuestForgeParseResponse>;
  engageQuestForge(
    request: PostQuestForgeEngageRequest,
  ): Promise<PostQuestForgeEngageResponse>;
  mergeAllGreen(): Promise<PostMergeAllGreenResponse>;
  getRepos(): Promise<GetReposResponse>;
  getRepoDeck(repoId: string): Promise<GetRepoDeckResponse>;
  getRepoTelemetry(
    repoId: string,
    options?: { force?: boolean },
  ): Promise<GetRepoTelemetryResponse>;
  getOperatives(): Promise<GetOperativesResponse>;
  getOperative(operativeId: string): Promise<GetOperativeResponse>;
  getActivity(repoId: string, limit?: number): Promise<GetActivityResponse>;
  getOperativeXp(operativeId: string): Promise<GetOperativeXpResponse>;
}

/**
 * Construct an api client bound to a single connection. Each call to
 * `apiClient(connection)` returns a fresh object so React consumers
 * can safely memoize per-connection.
 */
export const apiClient = (
  connection: SandcastleConnection,
  options?: ApiClientOptions,
): ApiClient => {
  const fetchFn = options?.fetch ?? fetch;

  const requestJson = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    const response = await fetchFn(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${connection.token}`,
        ...init?.headers,
      },
    });

    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? JSON.stringify((payload as { error: unknown }).error)
          : response.statusText;
      throw new Error(message);
    }
    return payload as T;
  };

  return {
    async getFleet() {
      return zGetFleetResponse.parse(await requestJson<unknown>("/fleet"));
    },

    async getRepo() {
      return zGetRepoResponse.parse(await requestJson<unknown>("/repo"));
    },

    async getRun(runId) {
      return zGetRunResponse.parse(
        await requestJson<unknown>(`/runs/${encodeURIComponent(runId)}`),
      );
    },

    async createRun(request) {
      return zPostRunsResponse.parse(
        await requestJson<unknown>("/runs", {
          method: "POST",
          body: JSON.stringify(request),
        }),
      );
    },

    async cancelRun(runId) {
      return zPostRunCancelResponse.parse(
        await requestJson<unknown>(
          `/runs/${encodeURIComponent(runId)}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({ id: runId }),
          },
        ),
      );
    },

    async decideRun(runId, kind) {
      return zPostRunDecisionResponse.parse(
        await requestJson<unknown>(
          `/runs/${encodeURIComponent(runId)}/decide`,
          {
            method: "POST",
            body: JSON.stringify({ kind }),
          },
        ),
      );
    },

    async parseQuestForge(directive) {
      return zPostQuestForgeParseResponse.parse(
        await requestJson<unknown>("/quest-forge/parse", {
          method: "POST",
          body: JSON.stringify({ directive }),
        }),
      );
    },

    async engageQuestForge(request) {
      return zPostQuestForgeEngageResponse.parse(
        await requestJson<unknown>("/quest-forge/engage", {
          method: "POST",
          body: JSON.stringify(request),
        }),
      );
    },

    async mergeAllGreen() {
      return zPostMergeAllGreenResponse.parse(
        await requestJson<unknown>("/merge-all-green", {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    },

    async getRepos() {
      return zGetReposResponse.parse(await requestJson<unknown>("/repos"));
    },

    async getRepoDeck(repoId) {
      return zGetRepoDeckResponse.parse(
        await requestJson<unknown>(`/repos/${encodeURIComponent(repoId)}/deck`),
      );
    },

    async getRepoTelemetry(repoId, options) {
      const qs = options?.force ? "?force=true" : "";
      return zGetRepoTelemetryResponse.parse(
        await requestJson<unknown>(
          `/repos/${encodeURIComponent(repoId)}/telemetry${qs}`,
        ),
      );
    },

    async getOperatives() {
      return zGetOperativesResponse.parse(
        await requestJson<unknown>("/operatives"),
      );
    },

    async getOperative(operativeId) {
      return zGetOperativeResponse.parse(
        await requestJson<unknown>(
          `/operatives/${encodeURIComponent(operativeId)}`,
        ),
      );
    },

    async getActivity(repoId, limit) {
      const qs =
        typeof limit === "number" ? `?limit=${encodeURIComponent(limit)}` : "";
      return zGetActivityResponse.parse(
        await requestJson<unknown>(
          `/repos/${encodeURIComponent(repoId)}/activity${qs}`,
        ),
      );
    },

    async getOperativeXp(operativeId) {
      return zGetOperativeXpResponse.parse(
        await requestJson<unknown>(
          `/operatives/${encodeURIComponent(operativeId)}/xp`,
        ),
      );
    },
  };
};
