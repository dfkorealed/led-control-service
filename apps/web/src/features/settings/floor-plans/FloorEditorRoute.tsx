import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
  const [isDirty, setIsDirty] = useState(false);
  const siteId = new URLSearchParams(location.search).get("siteId") ?? "default";
  const canEdit = userRole === "operator" || userRole === "admin";
  const editorQuery = useQuery({
    queryKey: ["floor-editor", siteId, floorId],
    queryFn: () => getFloorEditorState(floorId ?? ""),
    enabled: canEdit && Boolean(floorId)
  });
  const listPath = `/settings/floor-plans${location.search}`;

  useDirtyNavigationGuard(isDirty, () => setIsDirty(false));

  function leaveEditor() {
    if (isDirty && !window.confirm(discardMessage)) return;
    setIsDirty(false);
    navigate(listPath);
  }

  if (!canEdit) return <Navigate to={listPath} replace />;
  if (editorQuery.error) return <div className="panel danger">도면 편집기를 불러오지 못했습니다.</div>;
  if (editorQuery.isLoading || !editorQuery.data) return <div className="panel">도면 편집기를 불러오는 중</div>;

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
  useEffect(() => {
    if (!isDirty) return;

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
      if (window.confirm(discardMessage)) {
        onConfirmedLeave();
      } else {
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
  }, [isDirty, onConfirmedLeave]);
}
