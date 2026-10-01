import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listMonitoringIncidents, markMonitoringIncidentRead } from "../../../api/monitoring-incidents";

function activeDocument() { return document.visibilityState === "visible" && document.hasFocus(); }

export function useMonitoringIncidents(userId: string | undefined, siteId: string | undefined, open: boolean) {
  const client = useQueryClient();
  const enabled = Boolean(userId && siteId);
  const scope = useMemo(() => ({
    key: ["monitoring-incidents", userId, siteId] as const,
    lifetime: null as AbortController | null,
    pending: new Map<string, Promise<void>>(), confirmed: new Set<string>(), failures: new Set<string>()
  }), [userId, siteId]);
  const latestScope = useRef({ scope, open });
  latestScope.current = { scope, open };
  const [documentActive, setDocumentActive] = useState(activeDocument);
  const [readState, setReadState] = useState({ scope, failures: new Set<string>() });
  const getPage = async (signal: AbortSignal, limit: number, cursor?: string) => ({
    ...await listMonitoringIncidents(siteId!, { limit, ...(cursor ? { cursor } : {}) }, { signal }),
    // Pages and the closed summary can complete independently. The newest
    // successful GET supplies the count, including a newly fetched next page.
    receivedAt: performance.now()
  });
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
  const canonical = snapshots.reduce<typeof summary.data>((last, snapshot) => !last || snapshot.receivedAt > last.receivedAt ? snapshot : last, undefined);
  const query = open ? list : summary;

  useEffect(() => {
    // StrictMode replays effects with the same scope object. Every setup owns a
    // fresh controller; a response from a disposed lifetime cannot become live.
    const lifetime = new AbortController();
    scope.lifetime = lifetime;
    return () => { lifetime.abort(); };
  }, [scope]);
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

  return {
    incidents, unreadCount: canonical?.unreadCount, enabled, documentActive,
    isLoading: enabled && query.isPending, error: query.error, isStale: Boolean(query.error && canonical),
    readFailures: readState.scope === scope ? readState.failures : new Set<string>(), markRead,
    hasNextPage: list.hasNextPage, isFetchingNextPage: list.isFetchingNextPage,
    fetchNextPage: list.fetchNextPage, refetch: query.refetch
  };
}
