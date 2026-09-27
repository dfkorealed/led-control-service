import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateDimmingCommandInput, DetailRetentionAnchor } from "@led-control/shared";
import { apiGet, apiPost } from "./client";
import { useEffect, useRef } from "react";
import { isRetainedByClock, retentionNow, useDetailRetentionClock, withRetentionClock } from "./detail-retention";

export const commandReadRevalidation = {
  staleTime: 0,
  retry: false,
  refetchOnMount: "always",
  refetchOnWindowFocus: "always",
  refetchOnReconnect: "always"
} as const;

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

export interface CommandStatusResponse extends Partial<DetailRetentionAnchor> {
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
  errorCode?: "GATEWAY_CLOCK_UNTRUSTED" | null;
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
  generatedAt: string;
  retainedFrom: string;
}

export function listCommands(input: CommandHistoryInput) {
  const params = new URLSearchParams({ siteId: input.siteId });
  if (input.query) params.set("query", input.query);
  if (input.stage) params.set("stage", input.stage);
  if (input.cursor) params.set("cursor", input.cursor);
  params.set("limit", String(input.limit ?? 20));
  return withRetentionClock(() => apiGet<CommandHistoryResponse>(`/commands?${params}`));
}

export function useCommandHistory(userId: string, input: Omit<CommandHistoryInput, "cursor">, enabled = true) {
  const query = useInfiniteQuery({
    ...commandReadRevalidation,
    queryKey: ["command-history", userId, input],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listCommands({ ...input, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && Boolean(input.siteId)
  });
  // Use the most advanced server-time estimate to wake all loaded pages early.
  const clock = query.data?.pages.reduce<typeof query.data.pages[number]["retentionClock"]>((oldest, page) =>
    !oldest || retentionNow(page.retentionClock) > retentionNow(oldest) ? page.retentionClock : oldest, undefined);
  useDetailRetentionClock(query.data?.pages.flatMap((page) => page.items.map((item) => item.createdAt)) ?? [], clock,
    enabled && input.siteId ? query.refetch : undefined);
  const expired = query.data?.pages.some((page) => page.items.some((item) => !isRetainedByClock(item.createdAt, page.retentionClock)));
  const expirationRead = useRef(false);
  useEffect(() => {
    if (!expired) { expirationRead.current = false; return; }
    if (enabled && !expirationRead.current) { expirationRead.current = true; void query.refetch(); }
  }, [enabled, expired, query.refetch]);
  const data = !query.error && !query.isFetching && !query.isPaused && query.isFetchedAfterMount ? query.data : undefined;
  return { ...query, data: data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => isRetainedByClock(item.createdAt, page.retentionClock)) })) } : undefined };
}

export type CommandVerificationReason = "outcome_unknown" | "attempts_exhausted" | "gateway_unavailable";

export interface CommandVerificationCase {
  caseId: string;
  originalCommandId: string;
  siteId: string;
  targetCount: number;
  verificationAttemptCount: number;
  status: "verification_required" | "verification_in_progress";
  canRequestStatusCheck: boolean;
  lastCheckedAt: string | null;
  reasonCode: CommandVerificationReason;
}

export interface ActiveCommandVerificationCaseDetail extends CommandVerificationCase {
  targetFixtureIds: string[];
}

export interface ResolvedCommandVerificationCaseDetail {
  caseId: string;
  siteId: string;
  status: "verified_applied" | "verified_not_applied" | "verified_partial";
  targetCount: number;
  resolvedAt: string;
}

export type CommandVerificationCaseDetail = ActiveCommandVerificationCaseDetail | ResolvedCommandVerificationCaseDetail;

export function isActiveCommandVerificationCase(detail: CommandVerificationCaseDetail): detail is ActiveCommandVerificationCaseDetail {
  return detail.status === "verification_required" || detail.status === "verification_in_progress";
}

export function isResolvedCommandVerificationCase(detail: CommandVerificationCaseDetail): detail is ResolvedCommandVerificationCaseDetail {
  return detail.status === "verified_applied" || detail.status === "verified_not_applied" || detail.status === "verified_partial";
}

export interface CommandVerificationCasesInput {
  siteId: string;
  originalCommandId?: string;
  cursor?: string;
  limit?: number;
}

export interface CommandVerificationCasesResponse {
  items: CommandVerificationCase[];
  nextCursor: string | null;
  generatedAt: string;
}

export function listCommandVerificationCases(input: CommandVerificationCasesInput) {
  const params = new URLSearchParams({ siteId: input.siteId });
  if (input.originalCommandId) params.set("originalCommandId", input.originalCommandId);
  if (input.cursor) params.set("cursor", input.cursor);
  params.set("limit", String(input.limit ?? 4));
  return apiGet<CommandVerificationCasesResponse>(`/commands/requiring-verification?${params}`);
}

export function useCommandVerificationCases(userId: string, input: Omit<CommandVerificationCasesInput, "cursor">, enabled = true) {
  return useInfiniteQuery({
    ...commandReadRevalidation,
    queryKey: ["command-verification-cases", userId, input],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listCommandVerificationCases({ ...input, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && Boolean(input.siteId)
  });
}

function commandCasePath(caseId: string) {
  return `/commands/requiring-verification/${encodeURIComponent(caseId)}`;
}

export function getCommandVerificationCase(caseId: string) {
  return apiGet<CommandVerificationCaseDetail>(commandCasePath(caseId));
}

export interface CommandCaseStatusCheckResponse {
  caseId: string;
  dispatchId: string;
  dispatchIds: string[];
  verificationAttempt: number;
  terminalStatusUrl: string;
}

export function createCaseStatusCheck(caseId: string, clientRequestId: string, signal?: AbortSignal) {
  return apiPost<CommandCaseStatusCheckResponse>(`${commandCasePath(caseId)}/status-checks`, { clientRequestId }, { signal });
}

export interface CommandCaseReconcileInput {
  acknowledgeRisk: true;
  verificationMethod: "verified_physical_state" | "unable_to_verify";
  reason: string;
}

export interface CommandCaseReconcileResponse {
  caseId: string;
  reconciled: true;
  reconciledAt: string;
}

export function reconcileCommandCase(caseId: string, input: CommandCaseReconcileInput, signal?: AbortSignal) {
  return apiPost<CommandCaseReconcileResponse>(`${commandCasePath(caseId)}/reconcile`, input, { signal });
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
  const queryClient = useQueryClient();
  const query = useQuery({
    ...commandReadRevalidation,
    queryKey: ["command-status", commandId],
    queryFn: () => withRetentionClock(() => apiGet<CommandStatusResponse>(`/commands/${commandId}`)),
    enabled: Boolean(commandId),
    refetchInterval: (query) => getCommandStatusRefetchInterval(commandId, query.state.data, pendingVerificationDispatchIds, hasUnresolvedVerificationRequest)
  });
  useDetailRetentionClock([query.data?.createdAt], query.data?.retentionClock, commandId ? query.refetch : undefined);
  const retentionExpired = Boolean(query.data && !isRetainedByClock(query.data.createdAt, query.data.retentionClock));
  const expirationRead = useRef<string | null>(null);
  useEffect(() => {
    if (!retentionExpired) { expirationRead.current = null; return; }
    if (retentionExpired && commandId && expirationRead.current !== commandId) {
      expirationRead.current = commandId;
      void query.refetch();
    }
  }, [commandId, retentionExpired, query.refetch]);
  const data = !retentionExpired && !query.error && !query.isFetching && !query.isPaused && query.isFetchedAfterMount ? query.data : undefined;
  function isDetailCurrent() {
    const state = queryClient.getQueryState(["command-status", commandId]);
    // A click can beat React's refetch notification or retention timer. Check
    // cache authority and monotonic server time before allowing a physical action.
    return Boolean(data && isRetainedByClock(data.createdAt, data.retentionClock) && state?.fetchStatus === "idle"
      && !state.error && !state.isInvalidated && state.data === data);
  }
  return { ...query, retentionExpired, data, isDetailCurrent };
}
