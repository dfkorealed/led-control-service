import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { CreateDimmingCommandInput } from "@led-control/shared";
import { apiGet, apiPost } from "./client";

export type CommandDeliveryMode = "unicast" | "parallel_unicast" | "mesh_group";

export interface CreateDimmingCommandResponse {
  id: string;
  dispatchCount: number;
  selectedTargetCount: number;
  transmissionCount: number;
  deliveryMode: CommandDeliveryMode;
  terminalStatusUrl: string;
}

export type CommandStage = "queued" | "published" | "accepted" | "completed" | "partial_failed" | "failed" | "timed_out"
  | "verification_required" | "verified_applied" | "verified_not_applied" | "verified_partial";

export interface CommandStatusResponse {
  id: string;
  stage: CommandStage;
  // Optional for historical clients/cached responses predating outcome reporting.
  siteId?: string;
  outcome?: "pending" | "applied" | "not_applied" | "partially_applied" | "unknown" | null;
  verificationAttemptCount?: number;
  targetType?: "fixture" | "fixtures" | "floor" | "group";
  targetId?: string | null;
  targetFixtureIds?: string[];
  brightness?: number;
  createdAt?: string;
  dispatchCount: number;
  completedFixtureCount: number;
  totalFixtureCount: number;
  errorMessage: string | null;
  dispatches: Array<{
    id: string;
    kind?: "dimming" | "status_check";
    verificationAttempt?: number | null;
    status: string;
    gateway: { id: string; name: string };
    errorMessage: string | null;
    errorCode?: string | null;
    results: Array<{
      fixtureId: string;
      fixtureName: string;
      status: "pending" | "succeeded" | "failed" | "timed_out";
      errorMessage: string | null;
      brightness?: number | null;
    }>;
  }>;
}

export const TERMINAL_COMMAND_STAGES: ReadonlySet<CommandStage> = new Set([
  "completed",
  "partial_failed",
  "failed",
  "timed_out",
  "verification_required",
  "verified_applied",
  "verified_not_applied",
  "verified_partial"
]);

export function isTerminalCommandStage(stage: CommandStage | null | undefined): boolean {
  return Boolean(stage && TERMINAL_COMMAND_STAGES.has(stage));
}

export function getCommandStatusRefetchInterval(
  requestedCommandId: string | null,
  status: CommandStatusResponse | null | undefined,
  pendingVerificationDispatchIds?: string[],
  hasUnresolvedVerificationRequest = false
): 1000 | false {
  // GET may still return the pre-commit result when POST is pending, lost or
  // interrupted. Keep reading until that logical request can be resolved.
  if (hasUnresolvedVerificationRequest) return 1000;
  // A POST can finish before its new dispatch appears in a cached GET response.
  if (pendingVerificationDispatchIds?.some((id) => !status?.dispatches.some((dispatch) => dispatch.id === id))) return 1000;
  return status?.id === requestedCommandId && isSettledCommandStatus(status) ? false : 1000;
}

export function hasPendingStatusCheck(status: CommandStatusResponse): boolean {
  return status.dispatches.some((dispatch) => dispatch.kind === "status_check"
    && ["pending", "published", "accepted"].includes(dispatch.status));
}

export function isSettledCommandStatus(status: CommandStatusResponse | null | undefined): boolean {
  return Boolean(status && isTerminalCommandStage(status.stage) && !hasPendingStatusCheck(status));
}

export interface CommandHistoryInput {
  siteId: string;
  query?: string;
  stage?: CommandStage;
  cursor?: string;
  limit?: number;
}

export interface CommandHistoryResponse {
  items: Array<Omit<CommandStatusResponse, "dispatches">>;
  nextCursor: string | null;
}

export function listCommands(input: CommandHistoryInput) {
  const params = new URLSearchParams({ siteId: input.siteId });
  if (input.query) params.set("query", input.query);
  if (input.stage) params.set("stage", input.stage);
  if (input.cursor) params.set("cursor", input.cursor);
  params.set("limit", String(input.limit ?? 20));
  return apiGet<CommandHistoryResponse>(`/commands?${params}`);
}

export function useCommandHistory(userId: string, input: Omit<CommandHistoryInput, "cursor">) {
  return useInfiniteQuery({
    queryKey: ["command-history", userId, input],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listCommands({ ...input, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(input.siteId)
  });
}

export interface CommandStatusCheckResponse {
  dispatchId: string;
  dispatchIds: string[];
  verificationAttempt: number;
  terminalStatusUrl: string;
}

export function createCommandStatusCheck(commandId: string, clientRequestId: string, signal?: AbortSignal) {
  return apiPost<CommandStatusCheckResponse>(`/commands/${encodeURIComponent(commandId)}/status-checks`, { clientRequestId }, { signal });
}

export function createDimmingCommand(input: CreateDimmingCommandInput, signal?: AbortSignal) {
  return apiPost<CreateDimmingCommandResponse>(
    "/commands/dimming",
    canonicalizeDimmingCommandInput(input),
    { signal }
  );
}

export function canonicalizeDimmingCommandInput(
  input: CreateDimmingCommandInput
): CreateDimmingCommandInput {
  if (input.target.type !== "fixtures") return input;
  return {
    ...input,
    target: {
      ...input.target,
      fixtureIds: [...input.target.fixtureIds].sort()
    }
  };
}

export function useCommandStatus(commandId: string | null, pendingVerificationDispatchIds?: string[], hasUnresolvedVerificationRequest = false) {
  return useQuery({
    queryKey: ["command-status", commandId],
    queryFn: () => apiGet<CommandStatusResponse>(`/commands/${commandId}`),
    enabled: Boolean(commandId),
    refetchInterval: (query) => getCommandStatusRefetchInterval(commandId, query.state.data, pendingVerificationDispatchIds, hasUnresolvedVerificationRequest)
  });
}
