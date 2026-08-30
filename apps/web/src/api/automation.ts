import type {
  AutomationActionV1,
  AutomationExecutionKind,
  AutomationRuleStatus,
  DimmingTarget,
  LightingScheduleSnapshotV1,
  ScheduleRecurrenceV1
} from "@led-control/shared";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from "./client";

export type AutomationSyncStatus = "PENDING" | "APPLIED" | "REJECTED";

export type CreateScheduleInput = Omit<LightingScheduleSnapshotV1, "id" | "fixtureIds"> & {
  target: DimmingTarget;
};

export type UpdateScheduleInput = Partial<CreateScheduleInput>;

export interface ScheduleResponse {
  id: string;
  name: string;
  status: AutomationRuleStatus;
  activeFrom: string;
  activeUntil: string;
  localStartTime: string;
  localEndTime: string;
  recurrence: ScheduleRecurrenceV1;
  action: AutomationActionV1;
  fixtureIds: string[];
  gatewayId: string;
  targets: Array<{ fixtureId: string }>;
  targetCount: number;
  desiredRevision: number;
  appliedRevision: number;
  syncStatus: AutomationSyncStatus;
  nextOccurrence: {
    key: string;
    localDate: string;
    startsAt: string;
    endsAt: string;
  } | null;
  lastExecution: {
    id: string;
    eventId: string;
    sequence: string;
    revision: number;
    occurrenceKey: string | null;
    kind: AutomationExecutionKind;
    occurredAt: string;
    payload: unknown;
  } | null;
  createdById: string;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleListResponse {
  items: ScheduleResponse[];
  total: number;
  nextCursor: string | null;
}

export function scheduleQueryKey(siteId: string) {
  return ["automation-schedules", siteId] as const;
}

export function listSchedules(
  siteId: string,
  query: { limit?: number; cursor?: string } = {}
) {
  const search = new URLSearchParams({ limit: String(query.limit ?? 100) });
  if (query.cursor) search.set("cursor", query.cursor);
  return apiGet<ScheduleListResponse>(`${scheduleCollectionPath(siteId)}?${search.toString()}`);
}

export function createSchedule(siteId: string, input: CreateScheduleInput) {
  return apiPost<ScheduleResponse>(scheduleCollectionPath(siteId), input);
}

export function updateSchedule(siteId: string, scheduleId: string, input: UpdateScheduleInput) {
  return apiPatch<ScheduleResponse>(scheduleItemPath(siteId, scheduleId), input);
}

export function deleteSchedule(siteId: string, scheduleId: string) {
  return apiDelete<{
    id: string;
    deleted: true;
    desiredRevision: number;
    appliedRevision: number;
    syncStatus: AutomationSyncStatus;
  }>(scheduleItemPath(siteId, scheduleId));
}

export function scheduleMutationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "스케줄 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요.";
  }

  const code = errorCode(error.body);
  if (code === "schedule_overlap") {
    return "같은 대상과 시간대에 겹치는 활성 스케줄이 있습니다.";
  }
  if (code === "single_gateway_required") {
    return "같은 Gateway에 연결된 조명만 선택해 주세요.";
  }
  if (error.status === 400) return "스케줄 입력과 대상을 확인해 주세요.";
  if (error.status === 403) return "스케줄을 변경할 권한이 없습니다.";
  if (error.status === 404) return "스케줄 또는 현장을 찾을 수 없습니다.";
  if (error.status === 409) return "스케줄 변경이 현재 상태와 충돌했습니다.";
  return "스케줄 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요.";
}

function scheduleCollectionPath(siteId: string) {
  return `/sites/${encodeURIComponent(siteId)}/automation/schedules`;
}

function scheduleItemPath(siteId: string, scheduleId: string) {
  return `${scheduleCollectionPath(siteId)}/${encodeURIComponent(scheduleId)}`;
}

function errorCode(body: unknown) {
  if (!body || typeof body !== "object" || !("code" in body)) return null;
  return typeof body.code === "string" ? body.code : null;
}
