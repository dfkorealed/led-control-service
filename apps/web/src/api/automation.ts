import { scheduleCalendarResponseSchema, type ScheduleCalendarResponse } from "@led-control/shared/holiday-calendar-contracts";
export type { ScheduleCalendarResponse } from "@led-control/shared/holiday-calendar-contracts";
import type {
  AutomationActionV1,
  AutomationExecutionKind,
  AutomationRuleStatus,
  DimmingTarget,
  LightingScheduleSnapshotV1,
  LightingScheduleSnapshotV3,
  ScheduleRecurrenceV1,
  VehicleEventRuleSnapshotV1,
  VehicleSensorProtocol,
  BioSensorModeRequest
} from "@led-control/shared";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from "./client";
import type { BioSensorProfileV1 } from "@led-control/shared";

export type BioSensorBlockedReason = "profile_unverified" | "fingerprint_unverified" | "mode_unverified" | "link_unverified" | "catalog_pending" | "operating_policy_required" | "gateway_protocol_unverified" | "binding_changed" | "unsupported";
export interface BioSensorPreparationView {
  preparationCandidate: boolean;
  status: string;
  commandId: string | null;
  profileKey: string | null;
  observedAt: string | null;
  blockedReasons: BioSensorBlockedReason[];
}
export interface BioSensorPreparationOperation {
  commandId: string; siteId: string; fixtureId: string; operation: "query" | "ensure_sensor"; catalogRevision: number;
  status: "pending" | "ready" | "needs_setup" | "unverified" | "degraded" | "unsupported" | "failed" | "timed_out";
  requestedAt: string; expiresAt: string; supersededAt: string | null; observedAt: string | null; profileKey: string | null;
  modeVerified: boolean; linkVerified: boolean; blockReason: string | null; errorCode: string | null;
}
export function requestBioSensorPreparation(input: { siteId: string; fixtureId: string; clientRequestId: string; operation: "query" | "ensure_sensor" }) {
  return apiPost<BioSensorPreparationOperation>("/bio-sensor-preparations", input, { timeoutMs: 8_000 });
}
export function getBioSensorPreparation(commandId: string) {
  return apiGet<BioSensorPreparationOperation>(`/bio-sensor-preparations/${encodeURIComponent(commandId)}`, { timeoutMs: 8_000 });
}
export interface BioSensorPolicy { enabled: boolean; ownerUserId: string | null; maximumResponseSeconds: number | null; escalationAction: string | null; }
export function getBioSensorPolicy(siteId: string) { return apiGet<BioSensorPolicy & { revision: number }>(`/sites/${encodeURIComponent(siteId)}/bio-sensor-policy`); }
export function saveBioSensorPolicy(siteId: string, input: BioSensorPolicy) { return apiPut<BioSensorPolicy & { revision: number }>(`/sites/${encodeURIComponent(siteId)}/bio-sensor-policy`, input); }
export interface BioSensorProfileSummary { profileId: string; revision: number; status: "approved" | "revoked"; evidenceDigest: string; reuseScope: string; actorId: string; createdAt: string; }
export function listBioSensorProfiles() { return apiGet<BioSensorProfileSummary[]>("/bio-sensor-profiles"); }
export function createBioSensorProfile(input: BioSensorProfileV1) { return apiPost<Pick<BioSensorProfileSummary, "profileId" | "revision" | "status">>("/bio-sensor-profiles", input); }
export function revokeBioSensorProfile(profileId: string) { return apiPost<Pick<BioSensorProfileSummary, "profileId" | "revision" | "status">>(`/bio-sensor-profiles/${encodeURIComponent(profileId)}/revoke`, undefined); }

export type AutomationSyncStatus = "PENDING" | "APPLIED" | "REJECTED";

export interface AutomationListQuery {
  query?: string;
  status?: "enabled" | "disabled";
  syncStatus?: AutomationSyncStatus;
  limit?: number;
  cursor?: string;
}

export interface AutomationSiteSummary {
  ruleCount: number;
  syncRuleCounts: Record<AutomationSyncStatus, number>;
}

export type CreateScheduleInput = Omit<LightingScheduleSnapshotV1, "id" | "fixtureIds"> & Partial<Pick<LightingScheduleSnapshotV3, "excludeWeekends" | "excludeHolidays">> & {
  target: DimmingTarget;
};

export type UpdateScheduleInput = Partial<CreateScheduleInput>;

export interface ScheduleResponse {
  excludeWeekends?: boolean;
  excludeHolidays?: boolean;
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
  // Optional while previously deployed API instances remain reachable during rollout.
  filteredTotal?: number;
  siteSummary?: AutomationSiteSummary;
  nextCursor: string | null;
}

export type CreateVehicleEventRuleInput = Omit<VehicleEventRuleSnapshotV1, "id"> & { selfControlEnabled?: boolean };
export type UpdateVehicleEventRuleInput = Partial<CreateVehicleEventRuleInput>;

export interface VehicleEventRuleResponse extends VehicleEventRuleSnapshotV1 {
  selfControlEnabled?: boolean;
  sensorProtocol?: VehicleSensorProtocol;
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

export interface SensorModeVerification {
  commandId: string | null;
  status: string;
  modeVerified: boolean;
  verifiedAt: string | null;
}

export interface SensorModeOperationResponse extends SensorModeVerification {
  commandId: string;
  siteId: string;
  fixtureId: string;
  operation: "ensure_sensor" | "query";
  requeryOfCommandId: string | null;
  requestedAt: string;
  expiresAt: string;
  supersededAt: string | null;
  observedMode: "sensor" | "force-on" | "force-off" | null;
}

export type VehicleEventSourceBlockReason = "product_gate_off" | "capability_unverified" | BioSensorBlockedReason;
export interface VehicleEventSourceView {
  sensorProtocol: VehicleSensorProtocol;
  readiness: "off" | "shadow" | "ready" | "degraded";
  capabilityEvidence: "off" | "shadow" | "ready" | "degraded" | null;
  sourceEligible: boolean;
  targetEligible: boolean;
  blockReasons: VehicleEventSourceBlockReason[];
  modeVerification: SensorModeVerification;
}

/** Server-owned historical runtime evidence; never source readiness or optical output. */
export interface BioPulseTelemetryView {
  evidence: "gateway_runtime_telemetry";
  gatewayId: string;
  assignmentVersion: number;
  revision: number;
  lastPulseAt: string | null;
  health: "healthy" | "degraded" | "unverified";
  healthReason: string | null;
  degradedSince: string | null;
  restorationPending: boolean | null;
  restorationReason: string | null;
  targetFixtureIds: string[];
  lastEventAt: string;
  receivedAt: string;
  occurrences: Array<{
    ruleId: string;
    occurrenceKey: string;
    targetFixtureIds: string[];
    health: "healthy" | "degraded" | "unverified";
    degradedSince: string | null;
    restorationPending: boolean | null;
    restorationReason: string | null;
  }>;
  configurationReadback: {
    sensorProtocol: "bio-usb-pulse";
    verification: "configuration_readback";
    phase: "apply" | "restore";
    occurredAt: string;
    sequence: number;
    results: Array<{
      fixtureId: string;
      status: "pending" | "succeeded" | "failed" | "timed_out" | "superseded";
      configuration: { configuredHighBrightnessPercent: number; bioMode: "sensor" | "force-on" | "force-off" } | null;
    }>;
  } | null;
}

export function requestSensorMode(input: BioSensorModeRequest) {
  return apiPost<SensorModeOperationResponse>("/sensor-mode-operations", input);
}

export function getSensorModeOperation(commandId: string) {
  return apiGet<SensorModeOperationResponse>(`/sensor-mode-operations/${encodeURIComponent(commandId)}`);
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
  // Optional while previously deployed API instances remain reachable during rollout.
  filteredTotal?: number;
  siteSummary?: AutomationSiteSummary;
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
  query: AutomationListQuery = {}
) {
  const search = automationListParams(query);
  return apiGet<ScheduleListResponse>(`${scheduleCollectionPath(siteId)}?${search.toString()}`);
}

export function scheduleCalendarQueryKey(siteId: string) {
  return ["automation-schedule-calendar", siteId] as const;
}

export async function listScheduleCalendar(siteId: string, range: { from: string; to: string }, signal?: AbortSignal): Promise<ScheduleCalendarResponse> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  const raw = await apiGet<unknown>(`${scheduleCollectionPath(siteId)}/calendar?${params}`, { signal });
  const parsed = scheduleCalendarResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.from !== range.from || parsed.data.to !== range.to) {
    throw new ApiError("Incomplete calendar response", 502, { code: "schedule_calendar_incomplete" });
  }
  return parsed.data;
}

export function scheduleCalendarErrorMessage(error: unknown): string {
  if (isAutomationListAccessDenied(error)) return automationListAccessErrorMessage(error);
  const code = error instanceof ApiError ? errorCode(error.body) : null;
  if (code === "holiday_coverage_unavailable") return "공휴일 정보를 확인할 수 없어 달력을 표시하지 못했습니다.";
  if (code === "schedule_calendar_incomplete") return "완전한 달력 응답을 확인하지 못했습니다. 다시 조회해 주세요.";
  if (error instanceof ApiError && error.status === 400) return "달력 조회 기간을 확인해 주세요. 최대 42일까지 조회할 수 있습니다.";
  return "달력을 불러오지 못했습니다. 다시 조회해 주세요.";
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
  query: AutomationListQuery = {}
) {
  const search = automationListParams(query);
  return apiGet<VehicleEventRuleListResponse>(`${vehicleEventRuleCollectionPath(siteId)}?${search.toString()}`);
}

function automationListParams(query: AutomationListQuery) {
  const search = new URLSearchParams({ limit: String(query.limit ?? 100) });
  if (query.query) search.set("query", query.query);
  if (query.status) search.set("status", query.status);
  if (query.syncStatus) search.set("syncStatus", query.syncStatus);
  if (query.cursor) search.set("cursor", query.cursor);
  return search;
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
  if (code === "bio_self_control_unsupported") return "Gateway가 자기 조명 제어를 지원하지 않습니다. Gateway 적용 버전을 확인해 주세요.";
  if (code === "bio_self_hold_not_representable") return "자기 조명 유지시간은 127초까지 1초 단위, 그 이상은 1분 단위로 설정해 주세요.";
  if (code === "bio_self_brightness_invalid") return "자기 조명의 감지 밝기는 1% 이상으로 설정해 주세요.";
  if (code === "single_gateway_required") return "같은 Gateway에 연결된 조명만 선택해 주세요.";
  if (error.status === 409 && code === "bio_source_target_forbidden") return "감지 센서로 사용 중인 조명은 실행 대상으로 지정할 수 없습니다.";
  if (error.status === 400 && code === "bio_target_activation_conflict") return "다른 활성 이벤트와 실행 조명이 겹칩니다. 다른 이벤트를 비활성화하거나 실행 대상을 바꿔 주세요.";
  if (error.status === 503 && code === "gateway_deployment_read_only") return "점검 중에는 이벤트 규칙을 변경할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  if (error.status === 400) return "이벤트 규칙 입력과 대상을 확인해 주세요.";
  if (error.status === 403) return "이벤트 규칙을 변경할 권한이 없습니다.";
  if (error.status === 404) return "이벤트 규칙 또는 현장을 찾을 수 없습니다.";
  if (error.status === 409) return "이벤트 규칙 변경이 현재 상태와 충돌했습니다.";
  return "이벤트 규칙 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요.";
}

/** Preparation precedes the rule write. Explain only recognized server causes;
 * never expose arbitrary adapter diagnostics or imply that a rule was saved. */
export function bioSensorPreparationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "센서 준비 요청 결과를 확인하지 못했습니다. 잠시 후 같은 작업을 다시 시도해 주세요.";
  if (error.status === 401) return "로그인 세션이 만료되었습니다.";
  if (error.status === 403) return "센서 준비 권한이 없습니다. 현장 관리자에게 문의해 주세요.";
  if (error.status === 404) return "센서 준비 대상 또는 현장을 찾을 수 없습니다. 최신 조명 목록을 확인해 주세요.";
  if (error.status === 503 && errorCode(error.body) === "gateway_deployment_read_only") return "점검 중에는 센서 준비를 요청할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  const message = error.body && typeof error.body === "object" && "message" in error.body ? error.body.message : null;
  if (error.status === 409 && ["BIO completed registration graph mismatch", "confirmed BIO registration preparation required",
    "BIO fixture binding changed or unconfirmed"].includes(typeof message === "string" ? message : "")) {
    return "센서 준비 전 등록 연결 확인이 필요합니다. 설정의 현장 관리에서 해당 조명의 등록 연결을 확인해 주세요.";
  }
  if (error.status === 409) return "센서 준비가 현재 등록 또는 설정 상태와 충돌했습니다. 설정의 현장 관리에서 등록 연결과 센서 준비 상태를 확인해 주세요.";
  if (error.status === 400) return "센서 준비 요청 정보를 확인하지 못했습니다. 최신 조명 목록을 확인해 주세요.";
  return "센서 준비 요청을 완료하지 못했습니다. 서비스 연결 상태를 확인한 뒤 같은 작업을 다시 시도해 주세요.";
}

export function scheduleMutationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "스케줄 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요.";
  }

  if (error.status === 401) return "로그인 세션이 만료되었습니다.";
  const code = errorCode(error.body);
  if (code === "schedule_exclusions_bio_required") return "실행일 제외는 BIO 센서 조명만 지원합니다.";
  if (code === "schedule_exclusions_unsupported") return "Gateway가 실행일 제외 기능을 지원하지 않습니다. 적용 버전을 확인해 주세요.";
  if (code === "schedule_holiday_timezone_unsupported") return "휴일 제외는 현장 시간대 Asia/Seoul에서 지원합니다.";
  if (code === "holiday_coverage_unavailable") return "적용 기간의 공휴일 정보를 확인할 수 없습니다. 설정을 저장하지 않았습니다.";
  if (code === "holiday_storage_unavailable") return "공휴일 정보를 불러오지 못해 설정을 저장하지 못했습니다.";
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

// List reads use 404 for a missing site or revoked site-read grant; cached rows must not remain actionable.
export function isAutomationListAccessDenied(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function automationListAccessErrorMessage(error: unknown): string {
  if (isScheduleUnauthorized(error)) return "로그인 세션이 만료되었습니다.";
  return error instanceof ApiError && error.status === 404
    ? "현장을 찾을 수 없거나 조회 권한이 없습니다."
    : "현장을 조회할 권한이 없습니다.";
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
