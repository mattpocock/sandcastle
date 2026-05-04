import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PostRunsRequest } from "@sandcastle/protocol";
import { apiClient } from "./client";

export const queryKeys = {
  fleet: ["fleet"] as const,
  repo: ["repo"] as const,
  run: (runId: string) => ["run", runId] as const,
};

export const useFleet = () =>
  useQuery({
    queryKey: queryKeys.fleet,
    queryFn: () => apiClient.getFleet(),
  });

export const useRepo = () =>
  useQuery({
    queryKey: queryKeys.repo,
    queryFn: () => apiClient.getRepo(),
  });

export const useRun = (runId: string | undefined) =>
  useQuery({
    queryKey: queryKeys.run(runId ?? ""),
    queryFn: () => apiClient.getRun(runId ?? ""),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "victory" || status === "defeat" || status === "aborted"
        ? false
        : 2_000;
    },
  });

export const useCreateRun = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: PostRunsRequest) => apiClient.createRun(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
    },
  });
};

export const useCancelRun = (runId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.cancelRun(runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
    },
  });
};
