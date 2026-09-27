import { useEffect, useRef } from "react";

// Poll one visible cursor page. Infinite-query refetch would replay every visited page.
export function useAutomationVisiblePagePoll<T>({ enabled, scopeKey, pageKey, fetchPage, onSuccess, onError }: {
  enabled: boolean;
  scopeKey: string;
  pageKey: string;
  fetchPage: () => Promise<T>;
  onSuccess: (page: T) => void;
  onError: (error: unknown) => void;
}) {
  const latest = useRef({ scopeKey, pageKey, fetchPage, onSuccess, onError });
  const requestGeneration = useRef(0);
  const identity = useRef({ scopeKey, pageKey });
  if (identity.current.scopeKey !== scopeKey || identity.current.pageKey !== pageKey) {
    identity.current = { scopeKey, pageKey };
    requestGeneration.current += 1;
  }
  latest.current = { scopeKey, pageKey, fetchPage, onSuccess, onError };

  useEffect(() => () => { requestGeneration.current += 1; }, []);

  async function run(isActive: () => boolean) {
    const request = latest.current;
    const generation = ++requestGeneration.current;
    const stillCurrent = () => isActive() && generation === requestGeneration.current
      && latest.current.scopeKey === request.scopeKey && latest.current.pageKey === request.pageKey;
    try {
      const page = await request.fetchPage();
      if (stillCurrent()) request.onSuccess(page);
    } catch (error) {
      if (stillCurrent()) request.onError(error);
    }
  }

  function refresh() { return run(() => true); }

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: number;
    async function tick() {
      await run(() => !disposed);
      if (!disposed) timer = window.setTimeout(tick, 3000);
    }
    timer = window.setTimeout(tick, 3000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [enabled, scopeKey, pageKey]);

  return refresh;
}
