import { type QueryClient, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dismissAllMonitoringIncidents, dismissMonitoringIncident, listMonitoringIncidents, markMonitoringIncidentRead, type MonitoringIncidentsInput } from "../../../api/monitoring-incidents";
import { listPendingDismissalRequestIds, removePendingDismissalRequest, storePendingDismissalRequest } from "./monitoring-dismissal-request";

function activeDocument() { return document.visibilityState === "visible" && document.hasFocus(); }
// QueryClient owns both mode caches. Keep request order for that same lifetime,
// including StrictMode/remount, rather than resetting beneath cached snapshots.
const requestSequences = new WeakMap<QueryClient, number>();

export function useMonitoringIncidents(userId: string | undefined, siteId: string | undefined, open: boolean, conditions: Pick<MonitoringIncidentsInput, "status" | "type"> = {}) {
  const client = useQueryClient();
  const enabled = Boolean(userId && siteId);
  const scope = useMemo(() => ({
    key: ["monitoring-incidents", userId, siteId, "personal", conditions.status ?? "all", conditions.type ?? null] as const,
    account: { userId: userId!, siteId: siteId! },
    lifetime: null as AbortController | null,
    pending: new Map<string, Promise<void>>(), confirmed: new Set<string>(), failures: new Set<string>(),
    dismissing: new Set<string>(), bulkPending: false
  }), [userId, siteId, conditions.status, conditions.type]);
  const latestScope = useRef({ scope, open });
  latestScope.current = { scope, open };
  const [documentActive, setDocumentActive] = useState(activeDocument);
  const [readState, setReadState] = useState({ scope, failures: new Set<string>() });
  const [dismissalState, setDismissalState] = useState({ scope, failures: new Set<string>(), pending: new Set<string>(), bulkError: "", bulkPending: false, requestIds: [] as readonly string[] });
  const getPage = async (signal: AbortSignal, limit: number, cursor?: string) => {
    const requestOrder = (requestSequences.get(client) ?? 0) + 1;
    requestSequences.set(client, requestOrder);
    // Response completion is not authority: an older snapshot may arrive last.
    // Only a later-started successful GET can replace the canonical count.
    return { ...await listMonitoringIncidents(siteId!, { limit, view: "personal", ...conditions, ...(cursor ? { cursor } : {}) }, { signal }), requestOrder };
  };
  const summary = useQuery({
    queryKey: [...scope.key, "summary"], enabled: enabled && !open,
    queryFn: ({ signal }) => getPage(signal, 1), retry: false,
    refetchInterval: 30_000, refetchIntervalInBackground: false
  });
  const list = useInfiniteQuery({
    queryKey: [...scope.key, "list"], enabled: enabled && open,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => getPage(signal, 25, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false, refetchInterval: 30_000, refetchIntervalInBackground: false
  });
  const incidents = useMemo(() => {
    const rows = new Map(list.data?.pages.flatMap(page => page.incidents).map(incident => [incident.id, incident]));
    return [...rows.values()];
  }, [list.data]);
  const snapshots = [summary.data, ...(list.data?.pages ?? [])].filter(snapshot => snapshot !== undefined);
  const canonical = snapshots.reduce<typeof summary.data>((last, snapshot) => !last || snapshot.requestOrder > last.requestOrder ? snapshot : last, undefined);
  const query = open ? list : summary;

  useEffect(() => {
    // StrictMode replays effects with the same scope object. Every setup owns a
    // fresh controller; a response from a disposed lifetime cannot become live.
    const lifetime = new AbortController();
    scope.lifetime = lifetime;
    return () => { lifetime.abort(); };
  }, [scope]);
  useEffect(() => {
    if (!enabled) return;
    const readPending = () => {
      try {
        const requestIds = listPendingDismissalRequestIds(scope.account, window.localStorage);
        setDismissalState(previous => ({ ...(previous.scope === scope ? previous : { scope, failures: new Set<string>(), pending: new Set<string>(), bulkPending: false, bulkError: "" }), requestIds }));
      } catch {
        setDismissalState(previous => ({ ...(previous.scope === scope ? previous : { scope, failures: new Set<string>(), pending: new Set<string>(), bulkPending: false, requestIds: [] }), bulkError: "전체 지우기 요청 저장소를 확인하지 못했습니다. 브라우저 저장소를 확인하세요." }));
      }
    };
    readPending();
    window.addEventListener("storage", readPending);
    return () => window.removeEventListener("storage", readPending);
  }, [scope, enabled, open]);
  useEffect(() => {
    // Disabling an observer does not cancel its running query. Cancel the old
    // mode so its rows/errors, as well as its count, cannot become fresh later.
    void client.cancelQueries({ queryKey: [...scope.key, open ? "summary" : "list"] });
  }, [client, open, scope]);
  useEffect(() => {
    let changed = false;
    for (const incident of [...incidents, ...(summary.data?.incidents ?? [])]) {
      if (!incident.isRead) continue;
      // A successful GET can confirm a receipt after a failed PUT response or
      // another device's read. Missing/off-page rows never imply read success.
      scope.confirmed.add(incident.id);
      if (scope.failures.delete(incident.id)) changed = true;
    }
    if (changed) setReadState({ scope, failures: new Set(scope.failures) });
  }, [incidents, scope, summary.data]);
  useEffect(() => {
    const refresh = () => {
      const active = activeDocument();
      setDocumentActive(active);
      if (active && enabled) void client.invalidateQueries({ queryKey: scope.key });
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("blur", refresh);
    };
  }, [client, enabled, scope]);

  const markRead = useCallback((id: string, retry = false): Promise<void> => {
    const incident = incidents.find(item => item.id === id);
    const lifetime = scope.lifetime;
    if (!enabled || !lifetime || lifetime.signal.aborted || latestScope.current.scope !== scope || !latestScope.current.open
      || !activeDocument() || !incident || incident.isRead || scope.confirmed.has(id) || (scope.failures.has(id) && !retry)) return Promise.resolve();
    const pending = scope.pending.get(id);
    if (pending) return pending;
    const isCurrent = () => !lifetime.signal.aborted && scope.lifetime === lifetime && latestScope.current.scope === scope;
    const request = (async () => {
      try {
        await markMonitoringIncidentRead(siteId!, id, { signal: lifetime.signal });
        if (!isCurrent()) return;
        scope.confirmed.add(id);
        scope.failures.delete(id);
        setReadState({ scope, failures: new Set(scope.failures) });
        // A PUT confirms a personal receipt only. Do not change any badge or
        // row optimistically; server GET accounts for concurrent device reads.
        // Fence all pre-write GETs, including a disabled mode with no data;
        // invalidate alone only replaces the active query's existing refresh.
        await client.cancelQueries({ queryKey: scope.key });
        if (!isCurrent()) return;
        await client.invalidateQueries({ queryKey: scope.key });
      } catch {
        if (!isCurrent()) return;
        scope.failures.add(id);
        setReadState({ scope, failures: new Set(scope.failures) });
      } finally { scope.pending.delete(id); }
    })();
    scope.pending.set(id, request);
    return request;
  }, [client, enabled, incidents, scope, siteId]);

  const refreshAfterDismissal = useCallback(async (lifetime: AbortController) => {
    const key = ["monitoring-incidents", userId, siteId, "personal"];
    await client.cancelQueries({ queryKey: key });
    if (lifetime.signal.aborted || latestScope.current.scope !== scope) return;
    // Reset cursors only after confirmed server success. Failure keeps every
    // loaded page and badge; hiding never manufactures a read receipt.
    await client.resetQueries({ queryKey: [...scope.key, "list"] });
    if (lifetime.signal.aborted || latestScope.current.scope !== scope) return;
    await client.invalidateQueries({ queryKey: key });
  }, [client, userId, siteId, scope]);

  const dismiss = useCallback(async (id: string) => {
    const lifetime = scope.lifetime;
    if (!enabled || !lifetime || lifetime.signal.aborted || latestScope.current.scope !== scope || scope.dismissing.has(id) || scope.bulkPending || !incidents.some(item => item.id === id)) return;
    const isCurrent = () => !lifetime.signal.aborted && latestScope.current.scope === scope;
    scope.dismissing.add(id);
    setDismissalState(previous => ({ ...(previous.scope === scope ? previous : { scope, failures: new Set<string>(), requestIds: [], bulkError: "", bulkPending: false }), pending: new Set(scope.dismissing) }));
    try {
      await dismissMonitoringIncident(siteId!, id, { signal: lifetime.signal });
      if (!isCurrent()) return;
      setDismissalState(previous => ({ ...previous, failures: new Set([...previous.failures].filter(value => value !== id)) }));
      await refreshAfterDismissal(lifetime);
    } catch {
      if (isCurrent()) setDismissalState(previous => ({ ...previous, failures: new Set([...previous.failures, id]) }));
    } finally {
      scope.dismissing.delete(id);
      if (isCurrent()) setDismissalState(previous => ({ ...previous, pending: new Set(scope.dismissing) }));
    }
  }, [enabled, incidents, refreshAfterDismissal, scope, siteId]);

  const dismissAll = useCallback(async (existingRequestId?: string) => {
    const lifetime = scope.lifetime;
    if (!enabled || !lifetime || lifetime.signal.aborted || latestScope.current.scope !== scope || scope.bulkPending || scope.dismissing.size) return;
    const isCurrent = () => !lifetime.signal.aborted && latestScope.current.scope === scope;
    let requestId: string;
    try {
      const storage = window.localStorage;
      const pending = listPendingDismissalRequestIds(scope.account, storage);
      if (existingRequestId && !pending.includes(existingRequestId) || !existingRequestId && pending.length) throw new Error("Pending request must be recovered explicitly");
      requestId = existingRequestId ?? crypto.randomUUID();
      storePendingDismissalRequest(scope.account, requestId, storage);
      scope.bulkPending = true;
      setDismissalState(previous => ({ ...previous, scope, bulkPending: true, bulkError: "", requestIds: [...new Set([...pending, requestId])] }));
    } catch {
      setDismissalState(previous => ({ ...previous, scope, bulkError: "전체 지우기 요청을 저장하지 못했습니다. 브라우저 저장소를 확인하세요." }));
      return;
    }
    try {
      await dismissAllMonitoringIncidents(siteId!, requestId, { signal: lifetime.signal });
      // A confirmed old-scope result may clear its own durable key only. It
      // cannot refresh, empty or focus the newly selected account/site.
      removePendingDismissalRequest(scope.account, requestId, window.localStorage);
      if (!isCurrent()) return;
      setDismissalState(previous => ({ ...previous, requestIds: previous.requestIds.filter(id => id !== requestId), bulkError: "" }));
      await refreshAfterDismissal(lifetime);
    } catch {
      if (isCurrent()) setDismissalState(previous => ({ ...previous, bulkError: "전체 지우기 결과를 확인하지 못했습니다. 같은 요청의 결과 확인 및 다시 시도를 이용하세요." }));
    } finally {
      scope.bulkPending = false;
      if (isCurrent()) setDismissalState(previous => ({ ...previous, bulkPending: false }));
    }
  }, [enabled, refreshAfterDismissal, scope, siteId]);

  return {
    incidents, unreadCount: canonical?.unreadCount, enabled, documentActive,
    isLoading: enabled && query.isPending, error: query.error, isStale: Boolean(query.error && canonical),
    readFailures: readState.scope === scope ? readState.failures : new Set<string>(), markRead,
    dismiss, dismissAll,
    dismissalFailures: dismissalState.scope === scope ? dismissalState.failures : new Set<string>(),
    dismissalPending: dismissalState.scope === scope ? dismissalState.pending : new Set<string>(),
    bulkPending: dismissalState.scope === scope && dismissalState.bulkPending,
    bulkError: dismissalState.scope === scope ? dismissalState.bulkError : "",
    pendingDismissalRequestIds: dismissalState.scope === scope ? dismissalState.requestIds : [],
    hasNextPage: list.hasNextPage, isFetchingNextPage: list.isFetchingNextPage,
    fetchNextPage: list.fetchNextPage, refetch: query.refetch
  };
}
