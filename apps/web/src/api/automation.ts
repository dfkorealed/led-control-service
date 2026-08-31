import type {
  AutomationActionV1,
  AutomationExecutionKind,
  AutomationRuleStatus,
  DimmingTarget,
  LightingScheduleSnapshotV1,
  ScheduleRecurrenceV1,
  VehicleEventRuleSnapshotV1
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

export type CreateVehicleEventRuleInput = Omit<VehicleEventRuleSnapshotV1, "id">;
export type UpdateVehicleEventRuleInput = Partial<CreateVehicleEventRuleInput>;

export interface VehicleEventRuleResponse extends VehicleEventRuleSnapshotV1 {
  gatewayId: string;
  sources: Array<{ fixtureId: string }>;
  targets: Array<{ fixtureId: string }>;
  sourceCount: number;
  targetCount: number;
  desiredRevision: number;
  appliedRevision: number;
  syncStatus: AutomationSyncStatus;
  lastDetection: AutomationExecutionResponse | null;
  lastExecution: AutomationExecutionResponse | null;
  createdById: string;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
}

interface AutomationExecutionResponse {
  id: string;
  eventId: string;
  sequence: string;
  revision: number;
  occurrenceKey: string | null;
  kind: AutomationExecutionKind;
  occurredAt: string;
  payload: unknown;
}

export interface VehicleEventRuleListResponse {
  items: VehicleEventRuleResponse[];
  total: number;
  nextCursor: string | null;
}

export function scheduleQueryKey(siteId: string) {
  return ["automation-schedules", siteId] as const;
}

export function vehicleEventRuleQueryKey(siteId: string) {
  return ["automation-vehicle-event-rules", siteId] as const;
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

export function listVehicleEventRules(
  siteId: string,
  query: { limit?: number; cursor?: string } = {}
) {
  const search = new URLSearchParams({ limit: String(query.limit ?? 100) });
  if (query.cursor) search.set("cursor", query.cursor);
  return apiGet<VehicleEventRuleListResponse>(`${vehicleEventRuleCollectionPath(siteId)}?${search.toString()}`);
}

export function createVehicleEventRule(siteId: string, input: CreateVehicleEventRuleInput) {
  return apiPost<VehicleEventRuleResponse>(vehicleEventRuleCollectionPath(siteId), input);
}

export function updateVehicleEventRule(siteId: string, ruleId: string, input: UpdateVehicleEventRuleInput) {
  return apiPatch<VehicleEventRuleResponse>(vehicleEventRuleItemPath(siteId, ruleId), input);
}

export function deleteVehicleEventRule(siteId: string, ruleId: string) {
  return apiDelete<{
    id: string;
    deleted: true;
    desiredRevision: number;
    appliedRevision: number;
    syncStatus: AutomationSyncStatus;
  }>(vehicleEventRuleItemPath(siteId, ruleId));
}

export function vehicleEventMutationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "이벤트 규칙 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요.";
  if (error.status === 401) return "로그인 세션이 만료되었습니다.";
  const code = errorCode(error.body);
  if (code === "single_gateway_required") return "같은 Gateway에 연결된 조명만 선택해 주세요.";
  if (error.status === 400) return "이벤트 규칙 입력과 대상을 확인해 주세요.";
  if (error.status === 403) return "이벤트 규칙을 변경할 권한이 없습니다.";
  if (error.status === 404) return "이벤트 규칙 또는 현장을 찾을 수 없습니다.";
  if (error.status === 409) return "이벤트 규칙 변경이 현재 상태와 충돌했습니다.";
  return "이벤트 규칙 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요.";
}

export function scheduleMutationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "스케줄 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요.";
  }

  if (error.status === 401) return "로그인 세션이 만료되었습니다.";
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

export function isScheduleUnauthorized(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

export function scheduleQueryErrorMessage(error: unknown): string {
  return isScheduleUnauthorized(error)
    ? "로그인 세션이 만료되었습니다."
    : "스케줄 목록을 불러오지 못했습니다.";
}

function scheduleCollectionPath(siteId: string) {
  return `/sites/${encodeURIComponent(siteId)}/automation/schedules`;
}

function vehicleEventRuleCollectionPath(siteId: string) {
  return `/sites/${encodeURIComponent(siteId)}/automation/vehicle-event-rules`;
}

function scheduleItemPath(siteId: string, scheduleId: string) {
  return `${scheduleCollectionPath(siteId)}/${encodeURIComponent(scheduleId)}`;
}

function vehicleEventRuleItemPath(siteId: string, ruleId: string) {
  return `${vehicleEventRuleCollectionPath(siteId)}/${encodeURIComponent(ruleId)}`;
}

function errorCode(body: unknown) {
  if (!body || typeof body !== "object" || !("code" in body)) return null;
  return typeof body.code === "string" ? body.code : null;
}
