export interface DismissalRequestScope { userId: string; siteId: string }
type RequestStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
const namespace = "led-control:monitoring-dismissal:v1:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function scopePrefix(scope: DismissalRequestScope) {
  if (!uuid.test(scope.userId) || !uuid.test(scope.siteId)) throw new Error("Invalid dismissal request scope");
  return `${namespace}${scope.userId}:${scope.siteId}:`;
}
function requestKey(scope: DismissalRequestScope, clientRequestId: string) {
  if (!uuid.test(clientRequestId)) throw new Error("Invalid dismissal request ID");
  return `${scopePrefix(scope)}${clientRequestId}`;
}

export function listPendingDismissalRequestIds(scope: DismissalRequestScope, storage: RequestStorage): readonly string[] {
  const prefix = scopePrefix(scope);
  const ids: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!uuid.test(id)) throw new Error("Invalid stored dismissal request ID");
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored dismissal request");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 4 || record.version !== 1 || record.userId !== scope.userId || record.siteId !== scope.siteId || record.clientRequestId !== id) {
      throw new Error("Invalid stored dismissal request");
    }
    ids.push(id);
  }
  return ids.sort();
}

export function storePendingDismissalRequest(scope: DismissalRequestScope, clientRequestId: string, storage: RequestStorage): void {
  const key = requestKey(scope, clientRequestId);
  const value = JSON.stringify({ version: 1, ...scope, clientRequestId });
  // One key per request avoids a cross-tab read/modify/write array losing an
  // independent request. The verified write is the boundary before any POST.
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error("Dismissal request storage failed");
}

export function removePendingDismissalRequest(scope: DismissalRequestScope, clientRequestId: string, storage: RequestStorage): void {
  storage.removeItem(requestKey(scope, clientRequestId));
}
