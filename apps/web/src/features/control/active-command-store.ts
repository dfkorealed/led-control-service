import type { CreateDimmingCommandInput } from "@led-control/shared";
import { createDimmingCommandRequestSchema } from "@led-control/shared/dimming-command";
import { canonicalizeDimmingCommandInput } from "../../api/commands";

const STORAGE_PREFIX = "led-control:active-command:";
const RFC_4122_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCommandId(value: unknown): value is string {
  return typeof value === "string" && RFC_4122_UUID_PATTERN.test(value);
}

interface ActiveCommandRecord {
  commandId?: string;
  request?: CreateDimmingCommandInput;
  replayRejected?: boolean;
  replayRejectedCaseId?: string;
  reconciledOriginalCommandId?: string;
}

export function activeCommandStorageKey(userId: string, siteId: string): string {
  return `${userStoragePrefix(userId)}${encodeURIComponent(siteId)}`;
}

function observedCaseStorageKey(userId: string, siteId: string, originalCommandId: string): string {
  return `${activeCommandStorageKey(userId, siteId)}:case:${encodeURIComponent(originalCommandId)}`;
}

function pendingCaseCheckStorageKey(userId: string, siteId: string, caseId: string): string {
  return `${activeCommandStorageKey(userId, siteId)}:case-check:${encodeURIComponent(caseId)}`;
}

function recentResolvedCaseStorageKey(userId: string, siteId: string): string {
  return `${activeCommandStorageKey(userId, siteId)}:recent-resolved-case`;
}

export function saveRecentResolvedCaseId(userId: string, siteId: string, caseId: string): void {
  if (!caseId || caseId.length > 128) return;
  try { getSessionStorage()?.setItem(recentResolvedCaseStorageKey(userId, siteId), caseId); } catch {
    // The mounted view can still show the terminal result until reload.
  }
}

export function loadRecentResolvedCaseId(userId: string, siteId: string): string | null {
  try {
    const caseId = getSessionStorage()?.getItem(recentResolvedCaseStorageKey(userId, siteId));
    return caseId && caseId.length <= 128 ? caseId : null;
  } catch { return null; }
}

export function savePendingCaseStatusCheck(userId: string, siteId: string, caseId: string, clientRequestId: string): void {
  if (!caseId || caseId.length > 128 || !isCommandId(clientRequestId)) return;
  try { getSessionStorage()?.setItem(pendingCaseCheckStorageKey(userId, siteId, caseId), clientRequestId); } catch {
    // The mounted view retains the key; storage failure means reload recovery is unavailable.
  }
}

export function loadPendingCaseStatusCheck(userId: string, siteId: string, caseId: string): string | null {
  if (!caseId || caseId.length > 128) return null;
  try {
    const value = getSessionStorage()?.getItem(pendingCaseCheckStorageKey(userId, siteId, caseId));
    return isCommandId(value) ? value : null;
  } catch { return null; }
}

export function clearPendingCaseStatusCheck(userId: string, siteId: string, caseId: string, expectedClientRequestId: string): boolean {
  if (loadPendingCaseStatusCheck(userId, siteId, caseId) !== expectedClientRequestId) return false;
  try {
    getSessionStorage()?.removeItem(pendingCaseCheckStorageKey(userId, siteId, caseId));
    return true;
  } catch { return false; }
}

export function saveObservedVerificationCase(userId: string, siteId: string, originalCommandId: string, caseId: string): void {
  if (!isCommandId(originalCommandId) || !caseId || caseId.length > 128) return;
  try {
    getSessionStorage()?.setItem(observedCaseStorageKey(userId, siteId, originalCommandId), caseId);
  } catch {
    // The current mounted view can still keep the observed case in memory.
  }
}

export function loadObservedVerificationCase(userId: string, siteId: string, originalCommandId: string): string | null {
  if (!isCommandId(originalCommandId)) return null;
  try {
    const value = getSessionStorage()?.getItem(observedCaseStorageKey(userId, siteId, originalCommandId));
    return value && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}

export function clearObservedVerificationCase(userId: string, siteId: string, originalCommandId: string, expectedCaseId: string): boolean {
  if (!isCommandId(originalCommandId) || loadObservedVerificationCase(userId, siteId, originalCommandId) !== expectedCaseId) return false;
  try {
    getSessionStorage()?.removeItem(observedCaseStorageKey(userId, siteId, originalCommandId));
    return true;
  } catch {
    return false;
  }
}

function userStoragePrefix(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}:`;
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadActiveCommandId(userId: string, siteId: string): string | null {
  return loadRecord(userId, siteId)?.commandId ?? null;
}

export function loadActiveCommandRequest(userId: string, siteId: string): CreateDimmingCommandInput | null {
  return loadRecord(userId, siteId)?.request ?? null;
}

export function isActiveCommandReplayRejected(userId: string, siteId: string, clientRequestId: string): boolean {
  const record = loadRecord(userId, siteId);
  return record?.request?.clientRequestId === clientRequestId && record.replayRejected === true;
}

export function loadActiveCommandReplayRejectedCaseId(userId: string, siteId: string, clientRequestId: string): string | null {
  const record = loadRecord(userId, siteId);
  return record?.request?.clientRequestId === clientRequestId && record.replayRejected ? record.replayRejectedCaseId ?? null : null;
}

export function loadReconciledOriginalCommandId(userId: string, siteId: string, clientRequestId: string): string | null {
  const record = loadRecord(userId, siteId);
  return record?.request?.clientRequestId === clientRequestId && record.replayRejected
    ? record.reconciledOriginalCommandId ?? null : null;
}

export function markActiveCommandCaseReconciled(userId: string, siteId: string, clientRequestId: string, caseId: string, originalCommandId: string): boolean {
  const record = loadRecord(userId, siteId);
  if (!record?.replayRejected || record.request?.clientRequestId !== clientRequestId
    || record.replayRejectedCaseId !== caseId || !isCommandId(originalCommandId)) return false;
  saveRecord(userId, siteId, { ...record, reconciledOriginalCommandId: originalCommandId });
  return true;
}

export function markActiveCommandReplayRejected(userId: string, siteId: string, clientRequestId: string, caseId?: string): void {
  const record = loadRecord(userId, siteId);
  if (record?.request?.clientRequestId !== clientRequestId) return;
  // An explicit server safety rejection is not a lost response. Its idempotency
  // key may not have been reserved, so replay could become a new device Set.
  saveRecord(userId, siteId, { ...record, replayRejected: true, ...(caseId && caseId.length <= 128 ? { replayRejectedCaseId: caseId } : {}) });
}

export function saveActiveCommandRequest(userId: string, siteId: string, request: CreateDimmingCommandInput): void {
  if (request.siteId !== siteId) return;
  const parsed = parseCommandRequest(request);
  if (!parsed) return;
  saveRecord(userId, siteId, { request: canonicalizeDimmingCommandInput(parsed) });
}

export function saveActiveCommandId(userId: string, siteId: string, commandId: string): void {
  if (!isCommandId(commandId)) return;
  const current = loadRecord(userId, siteId);
  saveRecord(userId, siteId, { ...(current?.request ? { request: current.request } : {}), ...(current?.replayRejected ? { replayRejected: true } : {}), ...(current?.replayRejectedCaseId ? { replayRejectedCaseId: current.replayRejectedCaseId } : {}), ...(current?.reconciledOriginalCommandId ? { reconciledOriginalCommandId: current.reconciledOriginalCommandId } : {}), commandId });
}

export function clearActiveCommandId(userId: string, siteId: string, expectedCommandId: string): boolean {
  if (!isCommandId(expectedCommandId)) return false;

  const storage = getSessionStorage();
  if (!storage || loadActiveCommandId(userId, siteId) !== expectedCommandId) return false;

  try {
    storage.removeItem(activeCommandStorageKey(userId, siteId));
    return true;
  } catch {
    return false;
  }
}

export function clearActiveCommandRequest(
  userId: string,
  siteId: string,
  expectedClientRequestId: string
): boolean {
  if (!isCommandId(expectedClientRequestId)) return false;

  const storage = getSessionStorage();
  if (!storage || loadActiveCommandRequest(userId, siteId)?.clientRequestId !== expectedClientRequestId) return false;

  try {
    storage.removeItem(activeCommandStorageKey(userId, siteId));
    return true;
  } catch {
    return false;
  }
}

export function clearActiveCommandsForUser(userId: string): void {
  clearStoredActiveCommands(userStoragePrefix(userId));
}

export function clearAllActiveCommands(): void {
  clearStoredActiveCommands(STORAGE_PREFIX);
}

function clearStoredActiveCommands(prefix: string): void {
  const storage = getSessionStorage();
  if (!storage) return;

  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(prefix)));
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // Storage can become unavailable between reads; logout must still complete.
  }
}

function loadRecord(userId: string, siteId: string): ActiveCommandRecord | null {
  const storage = getSessionStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(activeCommandStorageKey(userId, siteId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;

    const candidate = value as { commandId?: unknown; request?: unknown; replayRejected?: unknown; replayRejectedCaseId?: unknown; reconciledOriginalCommandId?: unknown };
    const commandId = isCommandId(candidate.commandId) ? candidate.commandId : undefined;
    const parsedRequest = parseCommandRequest(candidate.request);
    const request = parsedRequest?.siteId === siteId
      ? canonicalizeDimmingCommandInput(parsedRequest)
      : undefined;
    return commandId || request ? { ...(commandId ? { commandId } : {}), ...(request ? { request } : {}), ...(request && candidate.replayRejected === true ? { replayRejected: true } : {}), ...(request && candidate.replayRejected === true && typeof candidate.replayRejectedCaseId === "string" && candidate.replayRejectedCaseId.length <= 128 ? { replayRejectedCaseId: candidate.replayRejectedCaseId } : {}), ...(request && candidate.replayRejected === true && isCommandId(candidate.reconciledOriginalCommandId) ? { reconciledOriginalCommandId: candidate.reconciledOriginalCommandId } : {}) } : null;
  } catch {
    return null;
  }
}

function parseCommandRequest(value: unknown): CreateDimmingCommandInput | null {
  // The compatibility schema accepts previously persisted timed commands and
  // strips their obsolete expiry before the request can be replayed.
  const parsed = createDimmingCommandRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function saveRecord(userId: string, siteId: string, record: ActiveCommandRecord): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(activeCommandStorageKey(userId, siteId), JSON.stringify(record));
  } catch {
    // Storage can be disabled or quota-limited; the current tab continues, but refresh recovery is unavailable.
  }
}
