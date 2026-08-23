const STORAGE_PREFIX = 'led-control:active-command:';

function isCommandId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
  const storage = getSessionStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(activeCommandStorageKey(siteId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('commandId' in parsed)) return null;

    const commandId = (parsed as { commandId: unknown }).commandId;
    return isCommandId(commandId) ? commandId : null;
  } catch {
    return null;
  }
}

export function saveActiveCommandId(siteId: string, commandId: string): void {
  if (!isCommandId(commandId)) return;

  const storage = getSessionStorage();
  if (!storage) return;

  try {
    storage.setItem(activeCommandStorageKey(siteId), JSON.stringify({ commandId }));
  } catch {
    // Storage can be disabled or quota-limited; the command remains recoverable from the server.
  }
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
