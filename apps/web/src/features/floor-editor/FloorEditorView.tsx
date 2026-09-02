import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Hand, Minus, MousePointer2, RotateCcw, Save, Square, Triangle, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import type { AuthUser } from "../../api/auth";
import { ApiError } from "../../api/client";
import { Button, PageHeader } from "../../components/ui";
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
  readOnly?: boolean;
  leaseToken?: string;
  leaseFence?: number;
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

export function FloorEditorView({
  initialState,
  userRole,
  readOnly = false,
  leaseToken,
  leaseFence,
  onCancel,
  onSaved,
  onReload,
  onDirtyChange
}: FloorEditorViewProps) {
  const queryClient = useQueryClient();
  const { initialState: baseline, state, isDirty, activeTool, zoom, initialize, adoptBaseline, setActiveTool, setZoom, resetZoom } = useFloorEditorStore();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error" | "conflict">("idle");
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [skippedFixtureCount, setSkippedFixtureCount] = useState(0);
  const [assetUploadPending, setAssetUploadPending] = useState(false);
  const mutationLock = useRef(false);
  const assetUploadLock = useRef(false);
  const noticeFloorId = useRef(initialState.floor.id);
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
    if (!mutationLock.current) setSaveStatus("idle");
    if (noticeFloorId.current !== initialState.floor.id) {
      noticeFloorId.current = initialState.floor.id;
      setSkippedFixtureCount(0);
    }
  }, [initialState, initialize]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  async function handleSave() {
    if (readOnly || !state || !baseline || !isDirty || mutationLock.current || assetUploadLock.current || !leaseToken || !leaseFence) return;
    mutationLock.current = true;
    setSaveStatus("saving");
    setSkippedFixtureCount(0);
    try {
      const saved = await saveFloorEditorState(state.floor.id, {
        ...buildEditorChanges(baseline, state),
        leaseToken,
        leaseFence
      });
      adoptBaseline(saved);
      await invalidateEditorQueries(queryClient, saved);
      await onSaved(saved);
    } catch (error) {
      setSaveStatus(error instanceof ApiError && error.status === 409 ? "conflict" : "error");
      return;
    } finally {
      mutationLock.current = false;
    }
    setSaveStatus("idle");
  }

  async function handleRestore(revision: number) {
    if (readOnly || !baseline || mutationLock.current || assetUploadLock.current || !leaseToken || !leaseFence) return;
    mutationLock.current = true;
    setRestoringRevision(revision);
    setSaveStatus("idle");
    setSkippedFixtureCount(0);
    try {
      const restored = await restoreFloorEditorRevision(baseline.floor.id, revision, {
        expectedRevision: baseline.floor.mapRevision,
        leaseToken,
        leaseFence
      });
      adoptBaseline(restored);
      setSkippedFixtureCount(restored.skippedFixtureIds.length);
      await invalidateEditorQueries(queryClient, restored);
    } catch (error) {
      setSaveStatus(error instanceof ApiError && error.status === 409 ? "conflict" : "error");
    } finally {
      mutationLock.current = false;
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
  const isMutationPending = saveStatus === "saving" || restoringRevision !== null;
  const isSaveOrRestoreBlocked = readOnly || isMutationPending || assetUploadPending;

  function handleAssetBusyChange(busy: boolean) {
    assetUploadLock.current = busy;
    setAssetUploadPending(busy);
  }

  return (
    <section className="floor-editor-shell">
      <PageHeader
        title={`${initialState.floor.name} 도면 편집`}
        description="도면 배경과 조명 위치, 표시 객체를 편집합니다."
        actions={(
          <div className="floor-editor-actions">
            <Button variant="ghost" className="floor-editor-icon-button" aria-label="축소" onClick={() => setZoom(zoom - 0.1)}>
              <ZoomOut size={18} aria-hidden="true" />
            </Button>
            <Button variant="secondary" className="floor-editor-zoom-reset" onClick={resetZoom}>100%</Button>
            <Button variant="ghost" className="floor-editor-icon-button" aria-label="확대" onClick={() => setZoom(zoom + 0.1)}>
              <ZoomIn size={18} aria-hidden="true" />
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              <Undo2 size={16} aria-hidden="true" />
              취소
            </Button>
            <Button
              variant="primary"
              disabled={!isDirty || isSaveOrRestoreBlocked}
              isLoading={saveStatus === "saving"}
              loadingLabel="저장 중"
              onClick={handleSave}
            >
              <Save size={16} aria-hidden="true" />
              저장
            </Button>
          </div>
        )}
      />

      {saveStatus === "error" ? <p className="danger-text" role="alert">변경분을 저장하지 못했습니다.</p> : null}
      {saveStatus === "conflict" ? (
        <div className="editor-conflict" role="alert">
          <span>다른 사용자가 먼저 저장했습니다.</span>
          <Button variant="secondary" onClick={() => void onReload()}>최신 버전 다시 불러오기</Button>
        </div>
      ) : null}
      {skippedFixtureCount > 0 ? (
        <p className="success-text" role="status">현재 존재하지 않는 조명 {skippedFixtureCount}개를 건너뛰었습니다.</p>
      ) : null}

      <div className="floor-editor-layout">
        <aside className="floor-editor-toolbar" role="toolbar" aria-label="도면 편집 도구">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Button
                key={tool.key}
                variant="ghost"
                className={activeTool === tool.key ? "active" : ""}
                aria-label={tool.label}
                title={tool.label}
                disabled={readOnly || isMutationPending}
                draggable={!readOnly && !isMutationPending && tool.key !== "select" && tool.key !== "pan"}
                onClick={() => setActiveTool(tool.key)}
                onDragStart={(event) => handleToolDragStart(event, tool.key)}
              >
                <Icon size={18} aria-hidden="true" />
              </Button>
            );
          })}
        </aside>
        <main className="floor-editor-stage">
          <FloorEditorCanvas readOnly={readOnly || isMutationPending} />
        </main>
        <div className="floor-editor-side-panel">
          <FloorAssetUploader readOnly={readOnly || isMutationPending} onBusyChange={handleAssetBusyChange} />
          <EditorPropertiesPanel readOnly={readOnly || isMutationPending} />
          <RevisionPanel
            revisions={revisions}
            canRestore={!readOnly && userRole === "admin"}
            isDirty={isDirty}
            restoringRevision={restoringRevision}
            isMutationPending={isSaveOrRestoreBlocked}
            isLoading={revisionsQuery.isLoading}
            isError={revisionsQuery.isError}
            hasNextPage={revisionsQuery.hasNextPage}
            isFetchingNextPage={revisionsQuery.isFetchingNextPage}
            onLoadMore={() => void revisionsQuery.fetchNextPage()}
            onRetry={() => void revisionsQuery.refetch()}
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
  isMutationPending,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  onRestore
}: {
  revisions: FloorEditorRevision[];
  canRestore: boolean;
  isDirty: boolean;
  restoringRevision: number | null;
  isMutationPending: boolean;
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onRestore: (revision: number) => void;
}) {
  return (
    <section className="editor-revisions" aria-label="도면 버전">
      <div>
        <span className="eyebrow">버전</span>
        <h3>변경 기록</h3>
      </div>
      {isLoading ? <p className="muted-text" role="status">버전 기록을 불러오는 중</p> : null}
      {isError ? (
        <div role="alert">
          <p className="danger-text">버전 기록을 불러오지 못했습니다.</p>
          <Button variant="secondary" onClick={onRetry}>다시 시도</Button>
        </div>
      ) : null}
      {!isLoading && !isError && revisions.length === 0 ? <p className="muted-text">저장된 버전이 없습니다.</p> : null}
      {!isLoading && !isError && revisions.length > 0 ? (
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
                <Button
                  variant="ghost"
                  className="editor-revision-restore"
                  aria-label={`리비전 ${revision.revision} 복구`}
                  title="이 버전 복구"
                  disabled={isDirty || isMutationPending}
                  onClick={() => onRestore(revision.revision)}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {!isError && hasNextPage ? (
        <Button variant="secondary" disabled={isFetchingNextPage} onClick={onLoadMore}>
          {isFetchingNextPage ? "불러오는 중" : "이전 버전 더 보기"}
        </Button>
      ) : null}
    </section>
  );
}

function revisionChangeCount(summary: Record<string, unknown>) {
  return Object.entries(summary).reduce((total, [key, value]) => {
    if (key === "restoredFromRevision") return total;
    if (typeof value === "number") return total + value;
    return key === "floorPlanChanged" && value === true ? total + 1 : total;
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
