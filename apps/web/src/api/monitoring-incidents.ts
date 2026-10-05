import { apiGet, apiPost, apiPut, type ApiRequestOptions } from "./client";

export type MonitoringIncidentType = "gateway_offline" | "fixture_stale" | "fixture_fault" | "command_failed";
export type MonitoringIncidentStatus = "open" | "acknowledged" | "resolved";
interface IncidentActor { id: string; name: string; loginId: string }
export interface MonitoringIncident {
  id: string; siteId: string; type: MonitoringIncidentType; status: MonitoringIncidentStatus;
  targetKey: string; fixtureId: string | null; gatewayId: string | null;
  openedAt: string; lastObservedAt: string; acknowledgedAt: string | null; resolvedAt: string | null;
  acknowledgedByUserId: string | null; assignedToUserId: string | null; resolvedByUserId: string | null;
  acknowledgedBy: IncidentActor | null; assignedTo: IncidentActor | null; resolvedBy: IncidentActor | null;
  resolutionKind: "automatic_recovery" | "operator_confirmed" | null; resolutionNote: string | null;
  createdAt: string; updatedAt: string;
  target: { kind: "fixture"; id: string; name: string; floorId: string } | { kind: "gateway"; id: string; name: string };
  isRead: boolean; readAt: string | null;
  isDismissed: boolean; dismissedAt: string | null;
}
export interface MonitoringIncidentsResponse {
  incidents: MonitoringIncident[];
  unreadCount: number;
  activeCount: number;
  nextCursor: string | null;
}
export interface MonitoringIncidentsInput {
  limit?: number; cursor?: string; status?: MonitoringIncidentStatus | "all"; type?: MonitoringIncidentType;
  view?: "all" | "personal";
}
export interface MonitoringIncidentReadReceipt { incidentId: string; isRead: true; readAt: string }
export interface MonitoringIncidentDismissal { incidentId: string; isDismissed: true; dismissedAt: string }
export interface MonitoringIncidentDismissalResult { siteId: string; clientRequestId: string; snapshotAt: string; dismissedCount: number }

export async function listMonitoringIncidents(siteId: string, input: MonitoringIncidentsInput = {}, options: ApiRequestOptions = {}): Promise<MonitoringIncidentsResponse> {
  const query = new URLSearchParams();
  for (const field of ["limit", "cursor", "status", "type", "view"] as const) {
    if (input[field] !== undefined) query.set(field, String(input[field]));
  }
  const body = await apiGet<unknown>(`${path(siteId)}${query.size ? `?${query}` : ""}`, options);
  if (!isObject(body) || !Array.isArray(body.incidents) || !isCount(body.unreadCount) || !isCount(body.activeCount)
    || !(body.nextCursor === null || isIdentifier(body.nextCursor)) || !body.incidents.every(row => isIncident(row, siteId))
    || body.incidents.filter(row => !row.isRead).length > body.unreadCount
    || body.incidents.filter(row => row.status !== "resolved").length > body.activeCount) {
    throw new Error("Invalid monitoring incidents response");
  }
  return body as unknown as MonitoringIncidentsResponse;
}
export async function dismissMonitoringIncident(siteId: string, incidentId: string, options: ApiRequestOptions = {}): Promise<MonitoringIncidentDismissal> {
  const body = await apiPut<unknown>(`${path(siteId)}/${encodeURIComponent(incidentId)}/dismiss`, {}, options);
  if (!isObject(body) || !exactKeys(body, ["incidentId", "isDismissed", "dismissedAt"]) || body.incidentId !== incidentId || body.isDismissed !== true || !isInstant(body.dismissedAt)) {
    throw new Error("Invalid monitoring incident dismissal");
  }
  return body as unknown as MonitoringIncidentDismissal;
}
export async function dismissAllMonitoringIncidents(siteId: string, clientRequestId: string, options: ApiRequestOptions = {}): Promise<MonitoringIncidentDismissalResult> {
  const body = await apiPost<unknown>(`${path(siteId)}/dismiss-all`, { clientRequestId }, options);
  if (!isObject(body) || !exactKeys(body, ["siteId", "clientRequestId", "snapshotAt", "dismissedCount"]) || body.siteId !== siteId || body.clientRequestId !== clientRequestId
    || !isInstant(body.snapshotAt) || !isCount(body.dismissedCount)) throw new Error("Invalid monitoring incident dismissal result");
  return body as unknown as MonitoringIncidentDismissalResult;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export async function markMonitoringIncidentRead(siteId: string, incidentId: string, options: ApiRequestOptions = {}): Promise<MonitoringIncidentReadReceipt> {
  const body = await apiPut<unknown>(`${path(siteId)}/${encodeURIComponent(incidentId)}/read`, {}, options);
  if (!isObject(body) || body.incidentId !== incidentId || body.isRead !== true || !isInstant(body.readAt)) {
    throw new Error("Invalid monitoring incident read receipt");
  }
  return body as unknown as MonitoringIncidentReadReceipt;
}

function path(siteId: string) { return `/sites/${encodeURIComponent(siteId)}/monitoring-incidents`; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isIdentifier(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isNullableString(value: unknown) { return value === null || typeof value === "string"; }
function isEnum(value: unknown, values: readonly string[]) { return typeof value === "string" && values.includes(value); }
function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const date = new Date(value);
  // Preserve the received precision, but reject Date.parse's normalization of
  // impossible calendar days instead of accepting an invented server instant.
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
function isNullableInstant(value: unknown) { return value === null || isInstant(value); }
function isActor(value: unknown) {
  return value === null || (isObject(value) && isIdentifier(value.id) && typeof value.name === "string" && typeof value.loginId === "string");
}
function isIncident(row: unknown, siteId: string) {
  if (!isObject(row) || row.siteId !== siteId || !isIdentifier(row.id) || !isIdentifier(row.targetKey)
    || !isEnum(row.type, ["gateway_offline", "fixture_stale", "fixture_fault", "command_failed"])
    || !isEnum(row.status, ["open", "acknowledged", "resolved"])) return false;
  if (!["openedAt", "lastObservedAt", "createdAt", "updatedAt"].every(key => isInstant(row[key]))
    || !["readAt", "acknowledgedAt", "resolvedAt"].every(key => isNullableInstant(row[key]))
    || !["fixtureId", "gatewayId", "acknowledgedByUserId", "assignedToUserId", "resolvedByUserId", "resolutionNote"].every(key => isNullableString(row[key]))
    || !["acknowledgedBy", "assignedTo", "resolvedBy"].every(key => isActor(row[key]))
    || !(row.resolutionKind === null || isEnum(row.resolutionKind, ["automatic_recovery", "operator_confirmed"]))
    || typeof row.isRead !== "boolean" || row.isRead !== (row.readAt !== null)
    || typeof row.isDismissed !== "boolean" || !isNullableInstant(row.dismissedAt) || row.isDismissed !== (row.dismissedAt !== null)) return false;
  const target = row.target;
  if (!isObject(target) || !isIdentifier(target.id) || typeof target.name !== "string") return false;
  return target.kind === "fixture" ? isIdentifier(target.floorId) && target.id === row.fixtureId
    : target.kind === "gateway" && target.id === row.gatewayId;
}
