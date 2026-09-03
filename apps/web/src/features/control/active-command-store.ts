import type { CreateDimmingCommandInput } from "@led-control/shared";
import { createDimmingCommandSchema } from "@led-control/shared/dimming-command";
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

export function activeCommandStorageKey(userId: string, siteId: string): string {
  return `${userStoragePrefix(userId)}${encodeURIComponent(siteId)}`;
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

export function saveActiveCommandRequest(userId: string, siteId: string, request: CreateDimmingCommandInput): void {
  if (request.siteId !== siteId) return;
  const parsed = parseCommandRequest(request);
  if (!parsed) return;
  saveRecord(userId, siteId, { request: canonicalizeDimmingCommandInput(parsed) });
}

export function saveActiveCommandId(userId: string, siteId: string, commandId: string): void {
  if (!isCommandId(commandId)) return;
  const current = loadRecord(userId, siteId);
  saveRecord(userId, siteId, { ...(current?.request ? { request: current.request } : {}), commandId });
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
  const storage = getSessionStorage();
  if (!storage) return;

  try {
    const prefix = userStoragePrefix(userId);
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
  const parsed = createDimmingCommandSchema.safeParse(value);
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
