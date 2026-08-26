import type { CreateDimmingCommandInput, DimmingTarget } from "@led-control/shared";
import { canonicalizeDimmingCommandInput } from "../../api/commands";

const STORAGE_PREFIX = "led-control:active-command:";
const RFC_4122_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCommandId(value: unknown): value is string {
  return typeof value === "string" && RFC_4122_UUID_PATTERN.test(value);
}

interface ActiveCommandRecord {
  commandId?: string;
  request?: CreateDimmingCommandInput;
}

export function activeCommandStorageKey(siteId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(siteId)}`;
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadActiveCommandId(siteId: string): string | null {
  return loadRecord(siteId)?.commandId ?? null;
}

export function loadActiveCommandRequest(siteId: string): CreateDimmingCommandInput | null {
  return loadRecord(siteId)?.request ?? null;
}

export function saveActiveCommandRequest(siteId: string, request: CreateDimmingCommandInput): void {
  if (request.siteId !== siteId) return;
  const parsed = parseCommandRequest(request);
  if (!parsed) return;
  saveRecord(siteId, { request: canonicalizeDimmingCommandInput(parsed) });
}

export function saveActiveCommandId(siteId: string, commandId: string): void {
  if (!isCommandId(commandId)) return;
  const current = loadRecord(siteId);
  saveRecord(siteId, { ...(current?.request ? { request: current.request } : {}), commandId });
}

export function clearActiveCommandId(siteId: string, expectedCommandId: string): boolean {
  if (!isCommandId(expectedCommandId)) return false;

  const storage = getSessionStorage();
  if (!storage || loadActiveCommandId(siteId) !== expectedCommandId) return false;

  try {
    storage.removeItem(activeCommandStorageKey(siteId));
    return true;
  } catch {
    return false;
  }
}

function loadRecord(siteId: string): ActiveCommandRecord | null {
  const storage = getSessionStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(activeCommandStorageKey(siteId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;

    const candidate = value as { commandId?: unknown; request?: unknown };
    const commandId = isCommandId(candidate.commandId) ? candidate.commandId : undefined;
    const parsedRequest = parseCommandRequest(candidate.request);
    const request = parsedRequest?.siteId === siteId
      ? canonicalizeDimmingCommandInput(parsedRequest)
      : undefined;
    return commandId || request ? { ...(commandId ? { commandId } : {}), ...(request ? { request } : {}) } : null;
  } catch {
    return null;
  }
}

function parseCommandRequest(value: unknown): CreateDimmingCommandInput | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isCommandId(candidate.siteId)
    || !isCommandId(candidate.clientRequestId)
    || !Number.isInteger(candidate.brightness)
    || (candidate.brightness as number) < 0
    || (candidate.brightness as number) > 100
  ) return null;

  const target = parseTarget(candidate.target);
  if (!target) return null;
  return {
    siteId: candidate.siteId,
    clientRequestId: candidate.clientRequestId,
    target,
    brightness: candidate.brightness as number
  };
}

function parseTarget(value: unknown): DimmingTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  if (target.type === "fixture" && isCommandId(target.fixtureId)) {
    return { type: "fixture", fixtureId: target.fixtureId };
  }
  if (target.type === "floor" && isCommandId(target.floorId)) {
    return { type: "floor", floorId: target.floorId };
  }
  if (target.type === "group" && isCommandId(target.groupId)) {
    return { type: "group", groupId: target.groupId };
  }
  if (
    target.type === "fixtures"
    && Array.isArray(target.fixtureIds)
    && target.fixtureIds.length >= 1
    && target.fixtureIds.length <= 1_000
    && target.fixtureIds.every(isCommandId)
    && new Set(target.fixtureIds).size === target.fixtureIds.length
  ) {
    return { type: "fixtures", fixtureIds: target.fixtureIds };
  }
  return null;
}

function saveRecord(siteId: string, record: ActiveCommandRecord): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(activeCommandStorageKey(siteId), JSON.stringify(record));
  } catch {
    // Storage can be disabled or quota-limited; the current tab continues, but refresh recovery is unavailable.
  }
}
