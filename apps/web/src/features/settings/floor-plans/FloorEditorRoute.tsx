import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { AuthUser } from "../../../api/auth";
import { getFloorEditorState } from "../../../api/floor-editor";
import { FloorEditorView } from "../../floor-editor/FloorEditorView";

interface FloorEditorRouteProps {
  userRole: AuthUser["role"];
}

const discardMessage = "저장하지 않은 변경사항이 있습니다. 이동하시겠습니까?";

export function FloorEditorRoute({ userRole }: FloorEditorRouteProps) {
  const { floorId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isDirty, setIsDirty] = useState(false);
  const selectedSiteId = new URLSearchParams(location.search).get("siteId");
  const canEdit = userRole === "operator" || userRole === "admin";
  const editorQuery = useQuery({
    queryKey: ["floor-editor", selectedSiteId ?? "unresolved", floorId],
    queryFn: () => getFloorEditorState(floorId ?? ""),
    enabled: canEdit && Boolean(floorId)
  });
  const listPath = `/settings/floor-plans${location.search}`;

  useEffect(() => {
    if (!editorQuery.data || selectedSiteId) return;
    const canonicalSiteId = editorQuery.data.floor.siteId;
    queryClient.setQueryData(["floor-editor", canonicalSiteId, floorId], editorQuery.data);
    const search = new URLSearchParams(location.search);
    search.set("siteId", canonicalSiteId);
    navigate({ pathname: location.pathname, search: search.toString() }, { replace: true });
  }, [editorQuery.data, floorId, location.pathname, location.search, navigate, queryClient, selectedSiteId]);

  useDirtyNavigationGuard(isDirty, () => setIsDirty(false));

  function leaveEditor() {
    if (isDirty && !window.confirm(discardMessage)) return;
    setIsDirty(false);
    navigate(listPath);
  }

  if (!canEdit) return <Navigate to={listPath} replace />;
  if (editorQuery.error) return <div className="panel danger">도면 편집기를 불러오지 못했습니다.</div>;
  if (editorQuery.isLoading || !editorQuery.data) return <div className="panel">도면 편집기를 불러오는 중</div>;
  if (!selectedSiteId) return <div className="panel">도면 편집기를 불러오는 중</div>;
  if (selectedSiteId !== editorQuery.data.floor.siteId) {
    return <Navigate to={`/settings/floor-plans?siteId=${encodeURIComponent(selectedSiteId)}`} replace />;
  }

  return (
    <FloorEditorView
      initialState={editorQuery.data}
      userRole={userRole}
      onDirtyChange={setIsDirty}
      onCancel={leaveEditor}
      onReload={async () => { await editorQuery.refetch(); }}
      onSaved={() => {
        setIsDirty(false);
        navigate(listPath);
      }}
    />
  );
}

function useDirtyNavigationGuard(isDirty: boolean, onConfirmedLeave: () => void) {
  const skipNextPopState = useRef(false);

  useEffect(() => {
    if (!isDirty) {
      skipNextPopState.current = false;
      return;
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
        onConfirmedLeave();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const handlePopState = () => {
      if (skipNextPopState.current) {
        skipNextPopState.current = false;
        return;
      }
      if (window.confirm(discardMessage)) {
        onConfirmedLeave();
      } else {
        skipNextPopState.current = true;
        window.history.forward();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleLinkClick, true);
    window.addEventListener("popstate", handlePopState);
    return () => {
      skipNextPopState.current = false;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleLinkClick, true);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isDirty, onConfirmedLeave]);
}
