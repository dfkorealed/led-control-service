import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { AuthUser } from "../../../api/auth";
import { getFloorEditorState } from "../../../api/floor-editor";
import { FloorEditorView } from "../../floor-editor/FloorEditorView";

interface FloorEditorRouteProps {
  userRole: AuthUser["role"];
}

export function FloorEditorRoute({ userRole }: FloorEditorRouteProps) {
  const { floorId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const canEdit = userRole === "operator" || userRole === "admin";
  const editorQuery = useQuery({
    queryKey: ["floor-editor", floorId],
    queryFn: () => getFloorEditorState(floorId ?? ""),
    enabled: canEdit && Boolean(floorId)
  });
  const listPath = `/settings/floor-plans${location.search}`;

  if (!canEdit) return <Navigate to={listPath} replace />;
  if (editorQuery.error) return <div className="panel danger">도면 편집기를 불러오지 못했습니다.</div>;
  if (editorQuery.isLoading || !editorQuery.data) return <div className="panel">도면 편집기를 불러오는 중</div>;

  return (
    <FloorEditorView
      initialState={editorQuery.data}
      onCancel={() => navigate(listPath)}
      onSaved={() => navigate(listPath)}
    />
  );
}
