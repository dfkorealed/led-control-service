import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { useDashboard, type SiteCapabilities } from "../../../api/queries";
import { Button, ConfirmDialog, FeedbackState } from "../../../components/ui";
import { MapLoadingOverlay } from "../../../components/ui/MapLoadingOverlay";
import {
  acquireFloorEditorLease,
  getFloorEditorState,
  releaseFloorEditorLease,
  type FloorEditorLease
} from "../../../api/floor-editor";
import { FloorEditorView } from "../../floor-editor/FloorEditorView";
import { dirtyEditorSentinelKey, hasDirtyEditorSentinel } from "../../floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "../../floor-editor/editor-store";

interface FloorEditorRouteProps {
  capabilities: SiteCapabilities;
}

const discardMessage = "저장하지 않은 변경사항이 있습니다. 이동하시겠습니까?";
const leaseHeartbeatMs = 30_000;
// Must remain aligned with EditorLeaseService. The client fails closed before Redis can expire the lease.
const serverFloorEditorLeaseTtlMs = 90_000;
const floorEditorLeaseSafetyMarginMs = 10_000;
const floorEditorLeaseDeadlineMs = serverFloorEditorLeaseTtlMs - floorEditorLeaseSafetyMarginMs;
const initialLeaseRetryDelaysMs = [250, 500, 1_000, 2_000, 4_000, 8_000];

// performance.now() is monotonic in the browser and can be controlled independently in timer tests.
const currentLeaseTime = () => performance.now();

interface FloorLeaseState {
  floorId: string | null;
  lease: FloorEditorLease;
}

interface PendingEditorLeave {
  onConfirm: () => void;
  onCancel?: () => void;
}

export function FloorEditorRoute({ capabilities }: FloorEditorRouteProps) {
  const { floorId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isDirty, setIsDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<PendingEditorLeave | null>(null);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const selectedSiteId = new URLSearchParams(location.search).get("siteId");
  const dashboard = useDashboard(selectedSiteId ?? undefined);
  const canEdit = capabilities.manage;
  const editorQuery = useQuery({
    queryKey: ["floor-editor", selectedSiteId ?? "unresolved", floorId],
    queryFn: () => getFloorEditorState(floorId ?? ""),
    enabled: canEdit && Boolean(floorId)
  });
  const listPath = `/settings/floor-plans${location.search}${location.hash}`;
  const leaseState = useFloorEditorLease(canEdit, floorId);

  useEffect(() => {
    if (!editorQuery.data || selectedSiteId) return;
    const canonicalSiteId = editorQuery.data.floor.siteId;
    queryClient.setQueryData(["floor-editor", canonicalSiteId, floorId], editorQuery.data);
    const search = new URLSearchParams(location.search);
    search.set("siteId", canonicalSiteId);
    navigate({ pathname: location.pathname, search: search.toString(), hash: location.hash }, { replace: true });
  }, [editorQuery.data, floorId, location.pathname, location.search, location.hash, navigate, queryClient, selectedSiteId]);

  const confirmEditorLeave = useCallback(() => {
    discardEditorChanges();
    setIsDirty(false);
  }, [discardEditorChanges]);

  const navigateFromEditor = useCallback((to: string) => {
    navigate(to, { replace: hasDirtyEditorSentinel() });
  }, [navigate]);

  const requestEditorLeave = useCallback((action: PendingEditorLeave) => {
    if (!isDirty) {
      action.onConfirm();
      return;
    }
    setPendingLeave(action);
  }, [isDirty]);

  const handleNativeBack = useDirtyNavigationGuard(isDirty, navigateFromEditor, requestEditorLeave, listPath);

  function leaveEditor() {
    requestEditorLeave({ onConfirm: () => navigateFromEditor(listPath) });
  }

  function cancelPendingLeave() {
    const action = pendingLeave;
    setPendingLeave(null);
    action?.onCancel?.();
  }

  function confirmPendingLeave() {
    const action = pendingLeave;
    if (!action) return;
    setPendingLeave(null);
    confirmEditorLeave();
    action.onConfirm();
  }

  if (!canEdit) return <Navigate to={listPath} replace />;
  if (editorQuery.error) return <div className="panel danger">맵 편집기를 불러오지 못했습니다.</div>;
  if (editorQuery.isLoading || !editorQuery.data || !selectedSiteId) return <div className="relative h-full min-h-0 bg-surface-canvas"><MapLoadingOverlay loading /></div>;
  if (selectedSiteId !== editorQuery.data.floor.siteId) {
    return <Navigate to={`/settings/floor-plans?siteId=${encodeURIComponent(selectedSiteId)}`} replace />;
  }

  const activeLease = leaseState.floorId === floorId ? leaseState.lease : { editable: false };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden [&>section]:min-h-0 [&>section]:flex-1">
      {!activeLease.editable ? (
        <div className="shrink-0">
          <FeedbackState
            tone="warning"
            icon={LockKeyhole}
            title={activeLease.holderName ? `${activeLease.holderName}님이 이 도면을 편집 중입니다.` : "편집 권한을 확보하지 못했습니다."}
            description="현재 버전은 읽기 전용으로 확인할 수 있습니다."
            action={<Button variant="secondary" disabled={leaseState.isAcquiring} onClick={leaseState.retry}>편집 권한 다시 요청</Button>}
          />
        </div>
      ) : null}
      <FloorEditorView
        key={`${selectedSiteId}:${floorId}`}
        initialState={editorQuery.data}
        initialPanelTab={new URLSearchParams(location.search).get("editorPanel") === "details" ? "details" : "properties"}
        userRole="admin"
        readOnly={!activeLease.editable}
        leaseToken={activeLease.token}
        leaseFence={activeLease.fence}
        floors={dashboard.data?.floors ?? [{ id: floorId!, name: editorQuery.data.floor.name }]}
        onFloorChange={(nextFloorId) => {
          if (nextFloorId === floorId || !dashboard.data?.floors.some((floor) => floor.id === nextFloorId)) return;
          requestEditorLeave({
            onConfirm: () => navigateFromEditor(`/settings/floor-plans/${encodeURIComponent(nextFloorId)}/edit${location.search}${location.hash}`)
          });
        }}
        onDirtyChange={setIsDirty}
        onNativeBack={handleNativeBack}
        onCancel={leaveEditor}
        onReload={async () => { await editorQuery.refetch(); }}
        onSaved={() => {
          // A stage receipt only ACKs its capture; newer preview edits can stay
          // dirty without another boolean transition in onDirtyChange.
          setIsDirty(useFloorEditorStore.getState().isDirty);
        }}
      />
      <ConfirmDialog
        isOpen={pendingLeave !== null}
        role="alertdialog"
        title="맵 편집 종료"
        confirmLabel="이동"
        onCancel={cancelPendingLeave}
        onConfirm={confirmPendingLeave}
      >
        {discardMessage}
      </ConfirmDialog>
    </div>
  );
}

function useFloorEditorLease(canEdit: boolean, floorId: string | undefined) {
  const [leaseState, setLeaseState] = useState<FloorLeaseState>({ floorId: null, lease: { editable: false } });
  const [attempt, setAttempt] = useState(0);
  const [isAcquiring, setIsAcquiring] = useState(true);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!canEdit || !floorId) return;

    setIsAcquiring(true);
    setLeaseState({ floorId, lease: { editable: false } });
    let disposed = false;
    let pageHidden = false;
    let nativeBackground = document.documentElement.dataset.ledControlNativeAppState === "background";
    let leaseLost = false;
    let acquiredToken: string | null = null;
    let heartbeat: number | null = null;
    let retryTimer: number | null = null;
    let leaseDeadlineTimer: number | null = null;
    let leaseDeadlineAt: number | null = null;
    let renewalInFlight = false;
    let initialAcquireInFlight = false;
    let retryAttempt = 0;
    const publish = (lease: FloorEditorLease) => {
      if (!disposed) setLeaseState({ floorId, lease });
    };
    const stopTimers = () => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (leaseDeadlineTimer !== null) window.clearTimeout(leaseDeadlineTimer);
      heartbeat = null;
      retryTimer = null;
      leaseDeadlineTimer = null;
      leaseDeadlineAt = null;
    };
    const loseLease = (lease: FloorEditorLease = { editable: false }) => {
      if (disposed || leaseLost) return;
      leaseLost = true;
      acquiredToken = null;
      stopTimers();
      publish(lease.editable ? { editable: false } : lease);
      setIsAcquiring(false);
    };
    const scheduleLeaseDeadline = (deadlineAt: number) => {
      const now = currentLeaseTime();
      if ((leaseDeadlineAt !== null && now >= leaseDeadlineAt) || now >= deadlineAt) {
        loseLease();
        return false;
      }
      if (leaseDeadlineTimer !== null) window.clearTimeout(leaseDeadlineTimer);
      leaseDeadlineAt = deadlineAt;
      const remainingMs = deadlineAt - now;
      leaseDeadlineTimer = window.setTimeout(() => loseLease(), remainingMs);
      return true;
    };
    const releaseAfterDispose = (token: string) => {
      const release = pageHidden
        ? releaseFloorEditorLease(floorId, token, { keepalive: true })
        : releaseFloorEditorLease(floorId, token);
      void release.catch(() => undefined);
    };
    const renewLease = async () => {
      const token = acquiredToken;
      if (disposed || leaseLost || renewalInFlight || !token) return;
      renewalInFlight = true;
      const deadlineAt = currentLeaseTime() + floorEditorLeaseDeadlineMs;
      try {
        const renewed = await acquireFloorEditorLease(floorId, token);
        if (disposed) {
          if (renewed.editable && renewed.token === token) releaseAfterDispose(token);
          return;
        }
        if (disposed || leaseLost || acquiredToken !== token) return;
        if (!renewed.editable || renewed.token !== token) {
          loseLease(renewed);
          return;
        }
        if (!scheduleLeaseDeadline(deadlineAt)) return;
        publish(renewed);
      } catch {
        if (!disposed && !leaseLost && acquiredToken === token) loseLease();
      } finally {
        renewalInFlight = false;
      }
    };
    const scheduleInitialRetry = (lease: FloorEditorLease) => {
      publish(lease);
      if (disposed || leaseLost || acquiredToken) return;
      if (retryAttempt >= initialLeaseRetryDelaysMs.length) {
        setIsAcquiring(false);
        return;
      }
      const delay = initialLeaseRetryDelaysMs[retryAttempt++];
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void acquireInitialLease();
      }, delay);
    };
    const acquireInitialLease = async () => {
      if (disposed || leaseLost || acquiredToken || initialAcquireInFlight) return;
      initialAcquireInFlight = true;
      const deadlineAt = currentLeaseTime() + floorEditorLeaseDeadlineMs;
      try {
        const acquired = await acquireFloorEditorLease(floorId);
        if (disposed) {
          if (acquired.editable && acquired.token) releaseAfterDispose(acquired.token);
          return;
        }
        if (leaseLost || acquiredToken) return;
        if (!acquired.editable || !acquired.token) {
          scheduleInitialRetry(acquired);
          return;
        }
        acquiredToken = acquired.token;
        if (!scheduleLeaseDeadline(deadlineAt)) {
          releaseAfterDispose(acquired.token);
          return;
        }
        publish(acquired);
        setIsAcquiring(false);
        heartbeat = window.setInterval(() => void renewLease(), leaseHeartbeatMs);
      } catch {
        if (!disposed && !leaseLost && !acquiredToken) scheduleInitialRetry({ editable: false });
      } finally {
        initialAcquireInFlight = false;
      }
    };

    const handlePageHide = () => {
      if (disposed) return;
      // beforeunload can be cancelled. Pagehide or lifecycle suspension ends
      // ownership; no token is persisted or shared with another tab.
      pageHidden = true;
      publish({ editable: false });
      setIsAcquiring(false);
      disposed = true;
      stopTimers();
      const token = acquiredToken;
      acquiredToken = null;
      if (token) releaseAfterDispose(token);
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      // A restored document must reacquire, never revive its released lease.
      if (event.persisted && pageHidden) retry();
    };
    const handleForeground = () => {
      if (nativeBackground || document.visibilityState === "hidden" || !pageHidden) return;
      // Background releases ownership, not the dirty editor store. Reacquire a
      // fresh token before unlocking; a delayed pre-suspension reply cannot revive it.
      pageHidden = false;
      retry();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") handlePageHide();
      else handleForeground();
    };
    const handleLifecycle = (event: Event) => {
      const state = (event as CustomEvent<{ state?: unknown }>).detail?.state;
      if (state === "background") { nativeBackground = true; handlePageHide(); }
      else if (state === "active") { nativeBackground = false; handleForeground(); }
      // inactive is focus loss (e.g. a file picker), not suspension.
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("led-control:webview-lifecycle", handleLifecycle);
    document.addEventListener("visibilitychange", handleVisibility);
    if (nativeBackground || document.visibilityState === "hidden") handlePageHide();
    else void acquireInitialLease();
    return () => {
      disposed = true;
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("led-control:webview-lifecycle", handleLifecycle);
      document.removeEventListener("visibilitychange", handleVisibility);
      stopTimers();
      const token = acquiredToken;
      acquiredToken = null;
      if (token) releaseAfterDispose(token);
    };
  }, [canEdit, floorId, attempt, retry]);

  return { ...leaseState, isAcquiring, retry };
}

function useDirtyNavigationGuard(
  isDirty: boolean,
  navigateFromEditor: (to: string) => void,
  requestEditorLeave: (action: PendingEditorLeave) => void,
  fallbackPath: string
) {
  const restoringSentinel = useRef(false);
  const allowNextPopState = useRef(false);
  const sentinelTokenRef = useRef<string | null>(null);
  const unmountCleanupTimer = useRef<number | null>(null);

  useEffect(() => {
    if (unmountCleanupTimer.current !== null) window.clearTimeout(unmountCleanupTimer.current);
    return () => {
      const sentinelToken = sentinelTokenRef.current;
      unmountCleanupTimer.current = window.setTimeout(() => {
        if (sentinelToken && hasDirtyEditorSentinel(sentinelToken)) window.history.back();
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (!isDirty) {
      allowNextPopState.current = false;
      const sentinelToken = sentinelTokenRef.current;
      sentinelTokenRef.current = null;
      if (sentinelToken && hasDirtyEditorSentinel(sentinelToken)) window.history.back();
      return;
    }

    const currentState = window.history.state ?? {};
    const existingToken = currentState[dirtyEditorSentinelKey] as string | undefined;
    const sentinelToken = existingToken ?? crypto.randomUUID();
    sentinelTokenRef.current = sentinelToken;
    if (!existingToken) {
      const currentIndex = typeof currentState.idx === "number" ? currentState.idx : 0;
      window.history.pushState(
        { ...currentState, idx: currentIndex + 1, [dirtyEditorSentinelKey]: sentinelToken },
        "",
        window.location.href
      );
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handleLinkClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      requestEditorLeave({
        onConfirm: () => navigateFromEditor(`${destination.pathname}${destination.search}${destination.hash}`)
      });
    };
    const handlePopState = (event: PopStateEvent) => {
      if (allowNextPopState.current) {
        allowNextPopState.current = false;
        return;
      }
      if (restoringSentinel.current && event.state?.[dirtyEditorSentinelKey] === sentinelToken) {
        restoringSentinel.current = false;
        return;
      }
      requestEditorLeave({
        onConfirm: () => {
          allowNextPopState.current = true;
          window.history.back();
        },
        onCancel: () => {
          restoringSentinel.current = true;
          window.history.forward();
        }
      });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleLinkClick, true);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleLinkClick, true);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isDirty, navigateFromEditor, requestEditorLeave]);

  return useCallback(() => {
    if (!isDirty) return false;
    requestEditorLeave({ onConfirm: () => {
      const token = sentinelTokenRef.current;
      const distance = token && hasDirtyEditorSentinel(token) ? 2 : 1;
      // Only confirmation may move history. Retire the owned sentinel first so
      // the clean effect/unmount cannot issue a second back while go is pending.
      sentinelTokenRef.current = null;
      const index: unknown = window.history.state?.idx;
      if (typeof index === "number" && Number.isInteger(index) && index >= distance) {
        allowNextPopState.current = true;
        window.history.go(-distance);
      } else navigateFromEditor(fallbackPath);
    } });
    return true;
  }, [isDirty, requestEditorLeave, navigateFromEditor, fallbackPath]);
}
