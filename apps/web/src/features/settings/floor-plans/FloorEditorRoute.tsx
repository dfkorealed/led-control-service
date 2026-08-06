import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { AuthUser } from "../../../api/auth";
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
  userRole: AuthUser["role"];
}

const discardMessage = "저장하지 않은 변경사항이 있습니다. 이동하시겠습니까?";
const leaseHeartbeatMs = 30_000;
export function FloorEditorRoute({ userRole }: FloorEditorRouteProps) {
  const { floorId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isDirty, setIsDirty] = useState(false);
  const [lease, setLease] = useState<FloorEditorLease>({ editable: false });
  const [leaseFloorId, setLeaseFloorId] = useState<string | null>(null);
  const leaseTokenRef = useRef<string | null>(null);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const selectedSiteId = new URLSearchParams(location.search).get("siteId");
  const canEdit = userRole === "operator" || userRole === "admin";
  const editorQuery = useQuery({
    queryKey: ["floor-editor", selectedSiteId ?? "unresolved", floorId],
    queryFn: () => getFloorEditorState(floorId ?? ""),
    enabled: canEdit && Boolean(floorId)
  });
  const listPath = `/settings/floor-plans${location.search}`;

  useEffect(() => {
    if (!canEdit || !floorId) return;

    let active = true;
    let heartbeat: number | null = null;
    const stopHeartbeat = () => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
    };
    const loseLease = (nextLease: FloorEditorLease = { editable: false }) => {
      leaseTokenRef.current = null;
      stopHeartbeat();
      if (active) {
        setLeaseFloorId(floorId);
        setLease(nextLease.editable ? { editable: false } : nextLease);
      }
    };
    const renewLease = async (token: string) => {
      try {
        const renewed = await acquireFloorEditorLease(floorId, token);
        if (!active) return;
        if (!renewed.editable || renewed.token !== token) {
          loseLease(renewed);
          return;
        }
        setLease(renewed);
      } catch {
        loseLease();
      }
    };
    const acquireLease = async () => {
      try {
        const acquired = await acquireFloorEditorLease(floorId);
        if (!active) {
          if (acquired.editable && acquired.token) void releaseFloorEditorLease(floorId, acquired.token).catch(() => undefined);
          return;
        }
        if (!acquired.editable || !acquired.token) {
          loseLease(acquired);
          return;
        }
        leaseTokenRef.current = acquired.token;
        setLeaseFloorId(floorId);
        setLease(acquired);
        heartbeat = window.setInterval(() => void renewLease(acquired.token!), leaseHeartbeatMs);
      } catch {
        loseLease();
      }
    };

    void acquireLease();
    return () => {
      active = false;
      stopHeartbeat();
      const token = leaseTokenRef.current;
      leaseTokenRef.current = null;
      if (token) void releaseFloorEditorLease(floorId, token).catch(() => undefined);
    };
  }, [canEdit, floorId]);

  useEffect(() => {
    if (!editorQuery.data || selectedSiteId) return;
    const canonicalSiteId = editorQuery.data.floor.siteId;
    queryClient.setQueryData(["floor-editor", canonicalSiteId, floorId], editorQuery.data);
    const search = new URLSearchParams(location.search);
    search.set("siteId", canonicalSiteId);
    navigate({ pathname: location.pathname, search: search.toString() }, { replace: true });
  }, [editorQuery.data, floorId, location.pathname, location.search, navigate, queryClient, selectedSiteId]);

  const confirmEditorLeave = useCallback(() => {
    discardEditorChanges();
    setIsDirty(false);
  }, [discardEditorChanges]);

  const navigateFromEditor = useCallback((to: string) => {
    navigate(to, { replace: hasDirtyEditorSentinel() });
  }, [navigate]);

  useDirtyNavigationGuard(isDirty, confirmEditorLeave, navigateFromEditor);

  function leaveEditor() {
    if (isDirty && !window.confirm(discardMessage)) return;
    if (isDirty) confirmEditorLeave();
    navigateFromEditor(listPath);
  }

  if (!canEdit) return <Navigate to={listPath} replace />;
  if (editorQuery.error) return <div className="panel danger">도면 편집기를 불러오지 못했습니다.</div>;
  if (editorQuery.isLoading || !editorQuery.data) return <div className="panel">도면 편집기를 불러오는 중</div>;
  if (!selectedSiteId) return <div className="panel">도면 편집기를 불러오는 중</div>;
  if (selectedSiteId !== editorQuery.data.floor.siteId) {
    return <Navigate to={`/settings/floor-plans?siteId=${encodeURIComponent(selectedSiteId)}`} replace />;
  }

  const activeLease = leaseFloorId === floorId ? lease : { editable: false };

  return (
    <>
      {!activeLease.editable ? (
        <p className="danger-text" role="alert">
          {activeLease.holderName
            ? `${activeLease.holderName}님이 ${formatLeaseTime(activeLease.acquiredAt)}부터 이 도면을 편집 중입니다. 읽기 전용으로 열었습니다.`
            : "편집 lease를 확보하지 못했습니다. 읽기 전용으로 열었습니다."}
        </p>
      ) : null}
      <FloorEditorView
        initialState={editorQuery.data}
        userRole={userRole}
        readOnly={!activeLease.editable}
        onDirtyChange={setIsDirty}
        onCancel={leaveEditor}
        onReload={async () => { await editorQuery.refetch(); }}
        onSaved={() => {
          setIsDirty(false);
          navigateFromEditor(listPath);
        }}
      />
    </>
  );
}

function formatLeaseTime(value: string | undefined) {
  if (!value) return "알 수 없는 시각";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "알 수 없는 시각" : date.toLocaleString("ko-KR");
}

function useDirtyNavigationGuard(
  isDirty: boolean,
  onConfirmedLeave: () => void,
  navigateFromEditor: (to: string) => void
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
      if (window.confirm(discardMessage)) {
        event.preventDefault();
        event.stopPropagation();
        onConfirmedLeave();
        navigateFromEditor(`${destination.pathname}${destination.search}${destination.hash}`);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
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
      if (window.confirm(discardMessage)) {
        onConfirmedLeave();
        allowNextPopState.current = true;
        window.history.back();
      } else {
        restoringSentinel.current = true;
        window.history.forward();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleLinkClick, true);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleLinkClick, true);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isDirty, navigateFromEditor, onConfirmedLeave]);
}
