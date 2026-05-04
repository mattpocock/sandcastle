import { z } from "zod";
import {
  zDeck,
  zFleetState,
  zOperativeIdentity,
  zOperativeRepoRecord,
  zRegisteredRepo,
  zRepoTelemetry,
  zRun,
  zMergeAllGreenResponse,
  zParsedPhase,
  zRunDecisionKind,
} from "./state.js";

const zRunBranchStrategy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("merge-to-head"), name: z.string().optional() }),
  z.object({
    type: z.literal("branch"),
    branch: z.string().min(1),
    baseBranch: z.string().optional(),
  }),
  z.object({ type: z.literal("head") }),
]);

export const zPostRunsRequest = z.object({
  directive: z.string().min(1),
  provider: z.enum(["claude-code", "codex", "pi", "opencode"]).optional(),
  model: z.string().optional(),
  operativeId: z.string().optional(),
  branchStrategy: zRunBranchStrategy.optional(),
  maxIterations: z.number().int().positive().optional(),
  completionSignal: z.union([z.string(), z.array(z.string())]).optional(),
});
export type PostRunsRequest = z.infer<typeof zPostRunsRequest>;

export const zPostRunsResponse = z.object({ runId: z.string() });
export type PostRunsResponse = z.infer<typeof zPostRunsResponse>;

export const zPostQuestForgeParseRequest = z.object({
  directive: z.string(),
});
export type PostQuestForgeParseRequest = z.infer<
  typeof zPostQuestForgeParseRequest
>;

export const zPostQuestForgeParseResponse = z.object({
  phases: z.array(zParsedPhase),
});
export type PostQuestForgeParseResponse = z.infer<
  typeof zPostQuestForgeParseResponse
>;

export const zPostQuestForgeEngageRequest = z.object({
  directive: z.string().min(1),
  phases: z.array(zParsedPhase).optional(),
  provider: z.enum(["claude-code", "codex", "pi", "opencode"]).optional(),
  model: z.string().optional(),
  operativeId: z.string().optional(),
  branchStrategy: zRunBranchStrategy.optional(),
  maxIterations: z.number().int().positive().optional(),
  completionSignal: z.union([z.string(), z.array(z.string())]).optional(),
});
export type PostQuestForgeEngageRequest = z.infer<
  typeof zPostQuestForgeEngageRequest
>;

export const zPostQuestForgeEngageResponse = z.object({ runId: z.string() });
export type PostQuestForgeEngageResponse = z.infer<
  typeof zPostQuestForgeEngageResponse
>;

export const zPostRunCancelRequest = z.object({ id: z.string() });
export type PostRunCancelRequest = z.infer<typeof zPostRunCancelRequest>;

export const zPostRunCancelResponse = z.object({
  runId: z.string(),
  cancelled: z.boolean(),
});
export type PostRunCancelResponse = z.infer<typeof zPostRunCancelResponse>;

export const zPostRunDecisionRequest = z.object({
  kind: zRunDecisionKind,
});
export type PostRunDecisionRequest = z.infer<typeof zPostRunDecisionRequest>;

export const zPostRunDecisionResponse = z.object({
  runId: z.string(),
  kind: zRunDecisionKind,
  ok: z.boolean(),
  message: z.string().optional(),
});
export type PostRunDecisionResponse = z.infer<typeof zPostRunDecisionResponse>;

export const zPostMergeAllGreenResponse = zMergeAllGreenResponse;
export type PostMergeAllGreenResponse = z.infer<
  typeof zPostMergeAllGreenResponse
>;

export const zGetRunResponse = zRun;
export type GetRunResponse = z.infer<typeof zGetRunResponse>;

export const zGetFleetResponse = zFleetState;
export type GetFleetResponse = z.infer<typeof zGetFleetResponse>;

export const zGetRepoResponse = z.object({
  root: z.string(),
  branch: z.string(),
});
export type GetRepoResponse = z.infer<typeof zGetRepoResponse>;

export const zGetReposResponse = z.object({
  repos: z.array(zRegisteredRepo),
});
export type GetReposResponse = z.infer<typeof zGetReposResponse>;

export const zPostReposRequest = z.object({
  root: z.string().min(1),
});
export type PostReposRequest = z.infer<typeof zPostReposRequest>;

export const zPostReposResponse = zRegisteredRepo;
export type PostReposResponse = z.infer<typeof zPostReposResponse>;

export const zDeleteRepoResponse = z.object({
  removed: z.boolean(),
});
export type DeleteRepoResponse = z.infer<typeof zDeleteRepoResponse>;

export const zGetRepoDeckResponse = zDeck;
export type GetRepoDeckResponse = z.infer<typeof zGetRepoDeckResponse>;

export const zGetRepoTelemetryResponse = zRepoTelemetry;
export type GetRepoTelemetryResponse = z.infer<
  typeof zGetRepoTelemetryResponse
>;

export const zGetOperativesResponse = z.object({
  operatives: z.array(zOperativeIdentity),
});
export type GetOperativesResponse = z.infer<typeof zGetOperativesResponse>;

export const zGetOperativeResponse = zOperativeIdentity.extend({
  repoRecord: zOperativeRepoRecord.optional(),
});
export type GetOperativeResponse = z.infer<typeof zGetOperativeResponse>;
