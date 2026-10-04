import type { CreateDimmingCommandInput } from "@led-control/shared";
import { createDimmingCommandRequestSchema } from "@led-control/shared/dimming-command";
import { canonicalizeDimmingCommandInput } from "../../api/commands";

const STORAGE_PREFIX = "led-control:active-command:";
const MOBILE_STORAGE_PREFIX = `${STORAGE_PREFIX}mobile:v1:`;
const RFC_4122_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_ERROR = "복구 정보를 저장하거나 읽을 수 없어 제어를 잠갔습니다. 앱을 다시 시작한 뒤 명령 상태를 확인하세요.";
let durableMobileStorage = false;
let storageError: string | null = null;
const storageListeners = new Set<() => void>();

/** Only the strict trusted native bootstrap may opt in, before React mounts.
 * A legacy window flag cannot select persistent storage.
 */
export function configureActiveCommandPersistence(verifiedMobileEnvironment: boolean): void {
  if (durableMobileStorage === verifiedMobileEnvironment) return;
  durableMobileStorage = verifiedMobileEnvironment;
  storageError = null;
  notifyStorageListeners();
}
export function getActiveCommandStorageError(): string | null { return storageError; }
export function subscribeActiveCommandStorage(listener: () => void): () => void {
  storageListeners.add(listener);
  return () => { storageListeners.delete(listener); };
}
function notifyStorageListeners() { storageListeners.forEach((listener) => listener()); }
function failStorage(): void {
  // An unreadable native record may already have reached hardware. Never
  // replace it with an empty record or silently fall back to session storage.
  if (!durableMobileStorage || storageError) return;
  storageError = STORAGE_ERROR;
  notifyStorageListeners();
}
function rejectInvalidRecovery(): false {
  // Native transport requires a persistable identity/payload. Validation
  // failure is not a successful save and must not allow an unrecorded POST.
  failStorage();
  return false;
}
function isCommandId(value: unknown): value is string {
  return typeof value === "string" && RFC_4122_UUID_PATTERN.test(value);
}
function isCaseId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
interface ActiveCommandRecord {
  commandId?: string;
  request?: CreateDimmingCommandInput;
  replayRejected?: boolean;
  replayRejectedCaseId?: string;
  reconciledOriginalCommandId?: string;
}
export interface PendingCommandStatusCheck {
  commandId: string;
  clientRequestId: string;
  dispatchIds?: string[];
}

function storagePrefix(): string { return durableMobileStorage ? MOBILE_STORAGE_PREFIX : STORAGE_PREFIX; }
function userStoragePrefix(userId: string, prefix = storagePrefix()): string {
  return `${prefix}${encodeURIComponent(userId)}:`;
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
function pendingCommandCheckStorageKey(userId: string, siteId: string, commandId: string): string {
  return `${activeCommandStorageKey(userId, siteId)}:command-check:${encodeURIComponent(commandId)}`;
}
function recentResolvedCaseStorageKey(userId: string, siteId: string): string {
  return `${activeCommandStorageKey(userId, siteId)}:recent-resolved-case`;
}

function withStorage<T>(operation: (storage: Storage) => T, fallback: T): T {
  if (typeof window === "undefined" || storageError) return fallback;
  try { return operation(durableMobileStorage ? window.localStorage : window.sessionStorage); }
  catch { failStorage(); return fallback; }
}
function readValue(key: string): string | null {
  return withStorage((storage) => storage.getItem(key), null);
}
function writeValue(key: string, value: string): boolean {
  return withStorage((storage) => { storage.setItem(key, value); return true; }, false);
}
function removeValue(key: string): boolean {
  return withStorage((storage) => { storage.removeItem(key); return true; }, false);
}
function loadCaseId(key: string): string | null {
  const value = readValue(key);
  if (value === null) return null;
  if (isCaseId(value)) return value;
  failStorage();
  return null;
}
function loadRequestId(key: string): string | null {
  const value = readValue(key);
  if (value === null) return null;
  if (isCommandId(value)) return value;
  failStorage();
  return null;
}
export function saveRecentResolvedCaseId(userId: string, siteId: string, caseId: string): boolean {
  return isCaseId(caseId) && writeValue(recentResolvedCaseStorageKey(userId, siteId), caseId);
}
export function loadRecentResolvedCaseId(userId: string, siteId: string): string | null {
  return loadCaseId(recentResolvedCaseStorageKey(userId, siteId));
}
export function savePendingCaseStatusCheck(userId: string, siteId: string, caseId: string, clientRequestId: string): boolean {
  return isCaseId(caseId) && isCommandId(clientRequestId)
    && writeValue(pendingCaseCheckStorageKey(userId, siteId, caseId), clientRequestId);
}
export function loadPendingCaseStatusCheck(userId: string, siteId: string, caseId: string): string | null {
  return isCaseId(caseId) ? loadRequestId(pendingCaseCheckStorageKey(userId, siteId, caseId)) : null;
}
export function clearPendingCaseStatusCheck(userId: string, siteId: string, caseId: string, expectedClientRequestId: string): boolean {
  return loadPendingCaseStatusCheck(userId, siteId, caseId) === expectedClientRequestId
    && removeValue(pendingCaseCheckStorageKey(userId, siteId, caseId));
}
export function savePendingCommandStatusCheck(userId: string, siteId: string, commandId: string, clientRequestId: string, dispatchIds?: string[]): boolean {
  if (!isCommandId(commandId) || !isCommandId(clientRequestId)
    || dispatchIds && !validDispatchIds(dispatchIds)) return rejectInvalidRecovery();
  // Preserve a pre-existing unreadable Get identity just like the original Set.
  // A response-loss retry must never overwrite it with a newly generated UUID.
  loadPendingCommandStatusCheck(userId, siteId, commandId);
  return writeValue(pendingCommandCheckStorageKey(userId, siteId, commandId), JSON.stringify({ commandId, clientRequestId, ...(dispatchIds ? { dispatchIds } : {}) }));
}
export function loadPendingCommandStatusCheck(userId: string, siteId: string, commandId: string): PendingCommandStatusCheck | null {
  if (!isCommandId(commandId)) return null;
  const raw = readValue(pendingCommandCheckStorageKey(userId, siteId, commandId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as PendingCommandStatusCheck;
    if (!value || value.commandId !== commandId || !isCommandId(value.clientRequestId)
      || value.dispatchIds !== undefined && !validDispatchIds(value.dispatchIds)) throw new Error("Invalid recovery record");
    return { commandId, clientRequestId: value.clientRequestId, ...(value.dispatchIds ? { dispatchIds: value.dispatchIds } : {}) };
  } catch { failStorage(); return null; }
}
function validDispatchIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1000
    && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128);
}
export function clearPendingCommandStatusCheck(userId: string, siteId: string, commandId: string, expectedClientRequestId: string): boolean {
  return loadPendingCommandStatusCheck(userId, siteId, commandId)?.clientRequestId === expectedClientRequestId
    && removeValue(pendingCommandCheckStorageKey(userId, siteId, commandId));
}
export function saveObservedVerificationCase(userId: string, siteId: string, originalCommandId: string, caseId: string): boolean {
  return isCommandId(originalCommandId) && isCaseId(caseId)
    && writeValue(observedCaseStorageKey(userId, siteId, originalCommandId), caseId);
}
export function loadObservedVerificationCase(userId: string, siteId: string, originalCommandId: string): string | null {
  return isCommandId(originalCommandId) ? loadCaseId(observedCaseStorageKey(userId, siteId, originalCommandId)) : null;
}
export function clearObservedVerificationCase(userId: string, siteId: string, originalCommandId: string, expectedCaseId: string): boolean {
  return isCommandId(originalCommandId) && loadObservedVerificationCase(userId, siteId, originalCommandId) === expectedCaseId
    && removeValue(observedCaseStorageKey(userId, siteId, originalCommandId));
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
  return saveRecord(userId, siteId, { ...record, reconciledOriginalCommandId: originalCommandId });
}
export function markActiveCommandReplayRejected(userId: string, siteId: string, clientRequestId: string, caseId?: string): boolean {
  const record = loadRecord(userId, siteId);
  if (record?.request?.clientRequestId !== clientRequestId) return false;
  // Explicit safety rejection is not response loss: replay could become a new Set.
  return saveRecord(userId, siteId, { ...record, replayRejected: true, ...(isCaseId(caseId) ? { replayRejectedCaseId: caseId } : {}) });
}
export function saveActiveCommandRequest(userId: string, siteId: string, request: CreateDimmingCommandInput): boolean {
  if (request.siteId !== siteId) return rejectInvalidRecovery();
  const parsed = parseCommandRequest(request);
  if (!parsed) return rejectInvalidRecovery();
  // Inspect first: an unreadable/corrupt native record cannot be replaced.
  loadRecord(userId, siteId);
  return saveRecord(userId, siteId, { request: canonicalizeDimmingCommandInput(parsed) });
}
export function saveActiveCommandId(userId: string, siteId: string, commandId: string): boolean {
  if (!isCommandId(commandId)) return rejectInvalidRecovery();
  const current = loadRecord(userId, siteId);
  return saveRecord(userId, siteId, { ...current, commandId });
}
export function clearActiveCommandId(userId: string, siteId: string, expectedCommandId: string): boolean {
  if (!isCommandId(expectedCommandId) || loadActiveCommandId(userId, siteId) !== expectedCommandId) return false;
  // Remove pending Get first; failed removal retains the active native lock.
  if (!removeValue(pendingCommandCheckStorageKey(userId, siteId, expectedCommandId))) return false;
  return removeValue(activeCommandStorageKey(userId, siteId));
}
export function clearActiveCommandRequest(userId: string, siteId: string, expectedClientRequestId: string): boolean {
  if (!isCommandId(expectedClientRequestId) || loadActiveCommandRequest(userId, siteId)?.clientRequestId !== expectedClientRequestId) return false;
  return removeValue(activeCommandStorageKey(userId, siteId));
}

export function clearActiveCommandsForUser(userId: string): void {
  clearStoredActiveCommands(userStoragePrefix(userId, STORAGE_PREFIX), userStoragePrefix(userId, MOBILE_STORAGE_PREFIX));
}
export function clearAllActiveCommands(): void {
  clearStoredActiveCommands(STORAGE_PREFIX, MOBILE_STORAGE_PREFIX);
}
function clearStoredActiveCommands(sessionPrefix: string, mobilePrefix: string): void {
  if (typeof window === "undefined") return;
  // Auth cleanup covers both namespaces, even after a fault. Successful cleanup
  // does not reset the document's latched safety error or remove other data.
  for (const [kind, prefix] of [["sessionStorage", sessionPrefix], ["localStorage", mobilePrefix]] as const) {
    try {
      const storage = window[kind];
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter((key): key is string => Boolean(key?.startsWith(prefix)));
      keys.forEach((key) => storage.removeItem(key));
    } catch { failStorage(); }
  }
}
function loadRecord(userId: string, siteId: string): ActiveCommandRecord | null {
  const raw = readValue(activeCommandStorageKey(userId, siteId));
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("Invalid recovery record");
    const candidate = value as ActiveCommandRecord;
    const commandId = isCommandId(candidate.commandId) ? candidate.commandId : undefined;
    const parsedRequest = parseCommandRequest(candidate.request);
    const request = parsedRequest?.siteId === siteId ? canonicalizeDimmingCommandInput(parsedRequest) : undefined;
    if (durableMobileStorage && (candidate.commandId !== undefined && !commandId
      || candidate.request !== undefined && !request || !commandId && !request
      || candidate.replayRejected !== undefined && typeof candidate.replayRejected !== "boolean"
      || candidate.replayRejectedCaseId !== undefined && !isCaseId(candidate.replayRejectedCaseId)
      || candidate.reconciledOriginalCommandId !== undefined && !isCommandId(candidate.reconciledOriginalCommandId))) {
      throw new Error("Invalid recovery record");
    }
    return commandId || request ? { ...(commandId ? { commandId } : {}), ...(request ? { request } : {}),
      ...(request && candidate.replayRejected === true ? { replayRejected: true } : {}),
      ...(request && candidate.replayRejected === true && isCaseId(candidate.replayRejectedCaseId) ? { replayRejectedCaseId: candidate.replayRejectedCaseId } : {}),
      ...(request && candidate.replayRejected === true && isCommandId(candidate.reconciledOriginalCommandId) ? { reconciledOriginalCommandId: candidate.reconciledOriginalCommandId } : {}) } : null;
  } catch { failStorage(); return null; }
}
function parseCommandRequest(value: unknown): CreateDimmingCommandInput | null {
  // Compatibility accepts legacy expiry, then strips it before explicit replay.
  const parsed = createDimmingCommandRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function saveRecord(userId: string, siteId: string, record: ActiveCommandRecord): boolean {
  return writeValue(activeCommandStorageKey(userId, siteId), JSON.stringify(record));
}
