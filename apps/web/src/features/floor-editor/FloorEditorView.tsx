import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Hand, Minus, MousePointer2, RotateCcw, Save, Square, Triangle, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { type DragEvent, useEffect, useState } from "react";
import type { AuthUser } from "../../api/auth";
import { ApiError } from "../../api/client";
import {
  listFloorEditorRevisions,
  restoreFloorEditorRevision,
  saveFloorEditorState,
  type FloorEditorRevision
} from "../../api/floor-editor";
import { EditorPropertiesPanel } from "./EditorPropertiesPanel";
import { FloorAssetUploader } from "./FloorAssetUploader";
import { FloorEditorCanvas } from "./FloorEditorCanvas";
import { buildEditorChanges } from "./editor-diff";
import { useFloorEditorStore } from "./editor-store";
import type { EditorTool, FloorEditorState } from "./editor-types";

interface FloorEditorViewProps {
  initialState: FloorEditorState;
  userRole: AuthUser["role"];
  onCancel: () => void;
  onSaved: (state: FloorEditorState) => void | Promise<void>;
  onReload: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

const tools: Array<{ key: EditorTool; label: string; icon: typeof MousePointer2 }> = [
  { key: "select", label: "선택", icon: MousePointer2 },
  { key: "pan", label: "이동", icon: Hand },
  { key: "rectangle", label: "사각형", icon: Square },
  { key: "triangle", label: "삼각형", icon: Triangle },
  { key: "line", label: "선", icon: Minus },
  { key: "text", label: "텍스트", icon: Type }
];
const TOOL_DRAG_DATA_TYPE = "application/x-floor-editor-tool";

export function FloorEditorView({ initialState, userRole, onCancel, onSaved, onReload, onDirtyChange }: FloorEditorViewProps) {
  const queryClient = useQueryClient();
  const { initialState: baseline, state, isDirty, activeTool, zoom, initialize, adoptBaseline, setActiveTool, setZoom, resetZoom } = useFloorEditorStore();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error" | "conflict">("idle");
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const floorId = state?.floor.id ?? initialState.floor.id;
  const siteId = state?.floor.siteId ?? initialState.floor.siteId;
  const revisionsQuery = useInfiniteQuery({
    queryKey: ["floor-editor-revisions", siteId, floorId],
    queryFn: ({ pageParam }) => listFloorEditorRevisions(floorId, pageParam === undefined ? {} : { cursor: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined
  });

  useEffect(() => {
    initialize(initialState);
    setSaveStatus("idle");
  }, [initialState, initialize]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  async function handleSave() {
    if (!state || !baseline || !isDirty || saveStatus === "saving") return;
    setSaveStatus("saving");
    try {
      const saved = await saveFloorEditorState(state.floor.id, buildEditorChanges(baseline, state));
      adoptBaseline(saved);
      setSaveStatus("idle");
      await invalidateEditorQueries(queryClient, saved);
      await onSaved(saved);
    } catch (error) {
      setSaveStatus(error instanceof ApiError && error.status === 409 ? "conflict" : "error");
    }
  }

  async function handleRestore(revision: number) {
    if (!baseline || restoringRevision !== null) return;
    setRestoringRevision(revision);
    setSaveStatus("idle");
    try {
      const restored = await restoreFloorEditorRevision(baseline.floor.id, revision, {
        expectedRevision: baseline.floor.mapRevision
      });
      adoptBaseline(restored);
      await invalidateEditorQueries(queryClient, restored);
    } catch (error) {
      setSaveStatus(error instanceof ApiError && error.status === 409 ? "conflict" : "error");
    } finally {
      setRestoringRevision(null);
    }
  }

  function handleToolDragStart(event: DragEvent<HTMLButtonElement>, tool: EditorTool) {
    if (tool === "select" || tool === "pan") return;
    setActiveTool(tool);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(TOOL_DRAG_DATA_TYPE, tool);
  }

  const revisions = revisionsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="floor-editor-shell">
      <header className="floor-editor-topbar">
        <div>
          <span className="eyebrow">층별 도면 에디터</span>
          <h2>{initialState.floor.name} 도면 편집</h2>
        </div>
        <div className="floor-editor-actions">
          <button className="icon-button" aria-label="축소" onClick={() => setZoom(zoom - 0.1)}>
            <ZoomOut size={18} />
          </button>
          <button className="zoom-reset-button" onClick={resetZoom}>100%</button>
          <button className="icon-button" aria-label="확대" onClick={() => setZoom(zoom + 0.1)}>
            <ZoomIn size={18} />
          </button>
          <button className="secondary-button" onClick={onCancel}>
            <Undo2 size={16} />
            취소
          </button>
          <button className="primary-button" disabled={!isDirty || saveStatus === "saving"} onClick={handleSave}>
            <Save size={16} />
            {saveStatus === "saving" ? "저장 중" : "저장"}
          </button>
        </div>
      </header>

      {saveStatus === "error" ? <p className="danger-text" role="alert">변경분을 저장하지 못했습니다.</p> : null}
      {saveStatus === "conflict" ? (
        <div className="editor-conflict" role="alert">
          <span>다른 사용자가 먼저 저장했습니다.</span>
          <button className="secondary-button" onClick={() => void onReload()}>최신 버전 다시 불러오기</button>
        </div>
      ) : null}

      <div className="floor-editor-layout">
        <aside className="floor-editor-toolbar" role="toolbar" aria-label="도면 편집 도구">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.key}
                className={activeTool === tool.key ? "active" : ""}
                aria-label={tool.label}
                title={tool.label}
                draggable={tool.key !== "select" && tool.key !== "pan"}
                onClick={() => setActiveTool(tool.key)}
                onDragStart={(event) => handleToolDragStart(event, tool.key)}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </aside>
        <main className="floor-editor-stage">
          <FloorEditorCanvas />
        </main>
        <div className="floor-editor-side-panel">
          <FloorAssetUploader />
          <EditorPropertiesPanel />
          <RevisionPanel
            revisions={revisions}
            canRestore={userRole === "operator" || userRole === "admin"}
            isDirty={isDirty}
            restoringRevision={restoringRevision}
            hasNextPage={revisionsQuery.hasNextPage}
            isFetchingNextPage={revisionsQuery.isFetchingNextPage}
            onLoadMore={() => void revisionsQuery.fetchNextPage()}
            onRestore={(revision) => void handleRestore(revision)}
          />
        </div>
      </div>
    </section>
  );
}

function RevisionPanel({
  revisions,
  canRestore,
  isDirty,
  restoringRevision,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRestore
}: {
  revisions: FloorEditorRevision[];
  canRestore: boolean;
  isDirty: boolean;
  restoringRevision: number | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRestore: (revision: number) => void;
}) {
  return (
    <section className="editor-revisions" aria-label="도면 버전">
      <div>
        <span className="eyebrow">버전</span>
        <h3>변경 기록</h3>
      </div>
      {revisions.length === 0 ? <p className="muted-text">저장된 버전이 없습니다.</p> : (
        <ol className="editor-revision-list">
          {revisions.map((revision) => (
            <li key={revision.revision}>
              <div>
                <strong>리비전 {revision.revision}</strong>
                <span>{revision.actor.displayName}</span>
                <time dateTime={revision.createdAt}>{formatRevisionTime(revision.createdAt)}</time>
                <span>변경 {revisionChangeCount(revision.changeSummary)}건</span>
              </div>
              {canRestore ? (
                <button
                  className="icon-button"
                  aria-label={`리비전 ${revision.revision} 복구`}
                  title="이 버전 복구"
                  disabled={isDirty || restoringRevision !== null}
                  onClick={() => onRestore(revision.revision)}
                >
                  <RotateCcw size={16} />
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {hasNextPage ? (
        <button className="secondary-button" disabled={isFetchingNextPage} onClick={onLoadMore}>
          {isFetchingNextPage ? "불러오는 중" : "이전 버전 더 보기"}
        </button>
      ) : null}
    </section>
  );
}

function revisionChangeCount(summary: Record<string, unknown>) {
  return Object.entries(summary).reduce((total, [key, value]) => {
    return key !== "restoredFromRevision" && typeof value === "number" ? total + value : total;
  }, 0);
}

function formatRevisionTime(createdAt: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(createdAt));
}

async function invalidateEditorQueries(queryClient: ReturnType<typeof useQueryClient>, state: FloorEditorState) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["dashboard", state.floor.siteId] }),
    queryClient.invalidateQueries({ queryKey: ["floor-editor", state.floor.siteId, state.floor.id] }),
    queryClient.invalidateQueries({ queryKey: ["floor-editor-revisions", state.floor.siteId, state.floor.id] })
  ]);
}
