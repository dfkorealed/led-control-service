import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Hand, Minus, MousePointer2, RotateCcw, Save, Square, Triangle, TriangleAlert, Type, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Focus } from "lucide-react";
import { type DragEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AuthUser } from "../../api/auth";
import { ApiError } from "../../api/client";
import { Button, FeedbackState, PageHeader } from "../../components/ui";
import {
  listFloorEditorRevisions,
  restoreFloorEditorRevision,
  saveFloorEditorState,
  type FloorEditorRevision
} from "../../api/floor-editor";
import { EditorPropertiesPanel } from "./EditorPropertiesPanel";
import { FixturePlacementList } from "./FixturePlacementList";
import { EditorBatchPlacementPanel } from "./EditorBatchPlacementPanel";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { FixtureIdentifyPanel } from "./FixtureIdentifyPanel";
import { loadEditorDraft, removeEditorDraft, saveEditorDraft, editorDraftGeneration } from "./editor-drafts";
import { authMeQueryKey } from "../../api/principal-cache";
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
  floors?: Array<{ id: string; name: string }>;
  onFloorChange?: (floorId: string) => void;
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
  onDirtyChange,
  floors,
  onFloorChange
}: FloorEditorViewProps) {
  readOnly ||= userRole !== "admin";
  const queryClient = useQueryClient();
  const { initialState: baseline, state, isDirty, activeTool, zoom, initialize, adoptBaseline, setActiveTool, setZoom, resetZoom, past, future, snap } = useFloorEditorStore(useShallow((s) => ({ initialState: s.initialState, state: s.state, isDirty: s.isDirty, activeTool: s.activeTool, zoom: s.zoom, initialize: s.initialize, adoptBaseline: s.adoptBaseline, setActiveTool: s.setActiveTool, setZoom: s.setZoom, resetZoom: s.resetZoom, past: s.past, future: s.future, snap: s.snap })));
  const [panelTab, setPanelTab] = useState("properties");
  const [recovery, setRecovery] = useState<FloorEditorState | null>(null);
  const [draftError, setDraftError] = useState(false);
  const userId = queryClient.getQueryData<{ user: AuthUser }>(authMeQueryKey)?.user.id;
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error" | "conflict">("idle");
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [skippedFixtureCount, setSkippedFixtureCount] = useState(0);
  const mutationLock = useRef(false);
  const activeInstance = useRef(true);
  const activeScope = useRef({ floorId: initialState.floor.id, siteId: initialState.floor.siteId });
  activeScope.current = { floorId: initialState.floor.id, siteId: initialState.floor.siteId };
  useLayoutEffect(() => { activeInstance.current = true; return () => { activeInstance.current = false; }; }, []);
  const noticeFloorId = useRef(initialState.floor.id);
  const floorId = initialState.floor.id;
  const siteId = initialState.floor.siteId;
  const revisionsQuery = useInfiniteQuery({
    queryKey: ["floor-editor-revisions", siteId, floorId],
    queryFn: ({ pageParam }) => listFloorEditorRevisions(floorId, pageParam === undefined ? {} : { cursor: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined
  });

  useLayoutEffect(() => {
    const current = useFloorEditorStore.getState();
    if (current.state === initialState) return;
    const sameScope = current.state?.floor.id === initialState.floor.id && current.state.floor.siteId === initialState.floor.siteId;
    if (sameScope && current.isDirty) return;
    // Query cache structural sharing can change response identity after a save.
    // Refresh a clean baseline without treating the current floor as newly opened.
    if (sameScope) adoptBaseline(initialState, true);
    else initialize(initialState);
    if (!mutationLock.current) setSaveStatus("idle");
    if (noticeFloorId.current !== initialState.floor.id) {
      noticeFloorId.current = initialState.floor.id;
      setSkippedFixtureCount(0);
    }
  }, [initialState, initialize, adoptBaseline]);

  useEffect(() => {
    if (!userId) return;
    const currentBaseline = initialState;
    setRecovery(loadEditorDraft(userId, currentBaseline));
    const generation = editorDraftGeneration();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      if (generation !== editorDraftGeneration()) return;
      const store = useFloorEditorStore.getState();
      if (store.isDirty && store.state?.floor.id === currentBaseline.floor.id && store.initialState?.floor.mapRevision === currentBaseline.floor.mapRevision) {
        setDraftError(!saveEditorDraft(userId, currentBaseline, store.state));
      }
    };
    const unsubscribe = useFloorEditorStore.subscribe((next, previous) => {
      if (next.state === previous.state) return;
      clearTimeout(timer);
      if (!next.isDirty && previous.isDirty) removeEditorDraft(userId, currentBaseline);
      else timer = setTimeout(persist, 300);
    });
    window.addEventListener("pagehide", persist);
    window.addEventListener("beforeunload", persist);
    return () => { clearTimeout(timer); persist(); unsubscribe(); window.removeEventListener("pagehide", persist); window.removeEventListener("beforeunload", persist); };
  }, [userId, initialState]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  async function handleSave() {
    if (readOnly || !state || !baseline || state.floor.id !== floorId || baseline.floor.id !== floorId || state.floor.siteId !== siteId || !isDirty || mutationLock.current || !leaseToken || !leaseFence) return;
    mutationLock.current = true;
    const principalGeneration = editorDraftGeneration();
    const stillCurrent = () => activeInstance.current && principalGeneration === editorDraftGeneration()
      && activeScope.current.floorId === floorId && activeScope.current.siteId === siteId
      && useFloorEditorStore.getState().initialState?.floor.id === floorId;
    setSaveStatus("saving");
    setSkippedFixtureCount(0);
    try {
      const saved = await saveFloorEditorState(state.floor.id, {
        ...buildEditorChanges(baseline, state),
        leaseToken,
        leaseFence
      });
      if (!stillCurrent()) return;
      if (saved.floor.id !== floorId || saved.floor.siteId !== siteId) throw new Error("Editor response scope mismatch");
      if (userId) removeEditorDraft(userId, baseline);
      adoptBaseline(saved);
      await invalidateEditorQueries(queryClient, saved);
      if (!stillCurrent()) return;
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
    if (readOnly || !baseline || baseline.floor.id !== floorId || isDirty || mutationLock.current || !leaseToken || !leaseFence) return;
    mutationLock.current = true;
    const principalGeneration = editorDraftGeneration();
    setRestoringRevision(revision);
    setSaveStatus("idle");
    setSkippedFixtureCount(0);
    try {
      const restored = await restoreFloorEditorRevision(baseline.floor.id, revision, {
        expectedRevision: baseline.floor.mapRevision,
        leaseToken,
        leaseFence
      });
      if (!activeInstance.current || principalGeneration !== editorDraftGeneration()
        || activeScope.current.floorId !== floorId || activeScope.current.siteId !== siteId
        || useFloorEditorStore.getState().initialState?.floor.id !== floorId) return;
      if (restored.floor.id !== floorId || restored.floor.siteId !== siteId) throw new Error("Editor response scope mismatch");
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
  const isSaveOrRestoreBlocked = readOnly || isMutationPending || state?.floor.id !== floorId;

  return (
    <section className="floor-editor-shell">
      <PageHeader
        title={`${initialState.floor.name} 도면 편집`}
        description={`리비전 ${baseline?.floor.mapRevision ?? initialState.floor.mapRevision}${isDirty ? " · 저장하지 않은 변경사항" : " · 저장됨"}`}
        actions={(
          <div className="floor-editor-actions">
            {floors && onFloorChange && <select aria-label="층 선택" value={floorId} disabled={isMutationPending} onChange={(e) => onFloorChange(e.target.value)}>{floors.map((floor) => <option value={floor.id} key={floor.id}>{floor.name}</option>)}</select>}
            <Button variant="ghost" aria-label="실행 취소" title="실행 취소" disabled={isSaveOrRestoreBlocked || !past.length} onClick={() => useFloorEditorStore.getState().undo()}><Undo2 size={18} /></Button>
            <Button variant="ghost" aria-label="다시 실행" title="다시 실행" disabled={isSaveOrRestoreBlocked || !future.length} onClick={() => useFloorEditorStore.getState().redo()}><Redo2 size={18} /></Button>
            <Button variant="ghost" className="floor-editor-icon-button" aria-label="축소" onClick={() => setZoom(zoom - 0.1)}>
              <ZoomOut size={18} aria-hidden="true" />
            </Button>
            <Button variant="secondary" className="floor-editor-zoom-reset" aria-label="100%" title="100%" onClick={resetZoom}>{Math.round(zoom * 100)}%</Button>
            <Button variant="ghost" className="floor-editor-icon-button" aria-label="확대" onClick={() => setZoom(zoom + 0.1)}>
              <ZoomIn size={18} aria-hidden="true" />
            </Button>
            <Button variant="ghost" aria-label="도면 맞춤" title="도면 맞춤" onClick={() => useFloorEditorStore.getState().fit()}><Maximize size={18} /></Button>
            <Button variant="ghost" aria-label="선택 맞춤" title="선택 맞춤" onClick={() => useFloorEditorStore.getState().fit(true)}><Focus size={18} /></Button>
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

      {saveStatus === "error" ? (
        <FeedbackState tone="danger" icon={TriangleAlert} title="변경분을 저장하지 못했습니다." />
      ) : null}
      {saveStatus === "conflict" ? (
        <FeedbackState
          tone="danger"
          icon={TriangleAlert}
          title="최신 도면과 변경사항이 충돌했습니다."
          description="최신 버전을 다시 불러온 뒤 변경사항을 확인하세요."
          action={<Button variant="secondary" onClick={() => { if (!isDirty || window.confirm("로컬 변경사항을 버리고 최신 버전을 불러올까요?")) { useFloorEditorStore.getState().discardChanges(); void onReload(); } }}>최신 버전 다시 불러오기</Button>}
        />
      ) : null}
      {recovery && <FeedbackState icon={TriangleAlert} tone="warning" title="저장하지 않은 로컬 초안이 있습니다." action={<div className="floor-editor-actions"><Button disabled={isSaveOrRestoreBlocked} onClick={() => { if (readOnly || mutationLock.current || recovery.floor.id !== activeScope.current.floorId) return; useFloorEditorStore.getState().recoverDraft(recovery); setRecovery(null); }}>초안 복구</Button><Button disabled={isMutationPending} onClick={() => { if (userId) removeEditorDraft(userId, initialState); setRecovery(null); }}>초안 삭제</Button></div>} />}
      {draftError && <FeedbackState icon={TriangleAlert} tone="warning" title="이 브라우저에 초안을 보관하지 못했습니다. 서버에 저장하세요." />}
      {skippedFixtureCount > 0 ? (
        <FeedbackState tone="success" icon={CircleCheck} title={`현재 존재하지 않는 조명 ${skippedFixtureCount}개를 건너뛰었습니다.`} />
      ) : null}

      <div className="floor-editor-layout">
        <div className="floor-editor-left-panel"><FixturePlacementList readOnly={readOnly || isMutationPending} />
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
                disabled={(readOnly && tool.key !== "pan" && tool.key !== "select") || isMutationPending}
                draggable={!readOnly && !isMutationPending && tool.key !== "select" && tool.key !== "pan"}
                onClick={() => setActiveTool(tool.key)}
                onDragStart={(event) => handleToolDragStart(event, tool.key)}
              >
                <Icon size={18} aria-hidden="true" />
              </Button>
            );
          })}
        </aside><label className="editor-snap"><input type="checkbox" checked={snap} disabled={readOnly} onChange={(e) => useFloorEditorStore.getState().setSnap(e.target.checked)} />격자 스냅</label></div>
        <main className="floor-editor-stage">
          <FloorEditorCanvas readOnly={readOnly || isMutationPending} />
        </main>
        <div className="floor-editor-side-panel">
          <div className="segmented-control" role="tablist" aria-label="편집 패널">{[["properties", "속성"], ["placement", "배치"], ["layers", "레이어"]].map(([value, label]) => <button role="tab" key={value} aria-selected={panelTab === value} onClick={() => setPanelTab(value)}>{label}</button>)}</div>
          {panelTab === "properties" && <EditorPropertiesPanel readOnly={readOnly || isMutationPending} />}
          {panelTab === "placement" && <EditorBatchPlacementPanel readOnly={readOnly || isMutationPending} />}
          {panelTab === "layers" && <EditorLayersPanel readOnly={readOnly || isMutationPending} />}
          <FixtureIdentifyPanel floorId={floorId} readOnly={readOnly || isMutationPending} leaseToken={leaseToken} leaseFence={leaseFence} />
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
  queryClient.setQueryData(["floor-editor", state.floor.siteId, state.floor.id], state);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["dashboard", state.floor.siteId] }),
    queryClient.invalidateQueries({ queryKey: ["floor-fixtures", state.floor.siteId, state.floor.id] }),
    queryClient.invalidateQueries({ queryKey: ["floor-map", state.floor.siteId, state.floor.id] }),
    queryClient.invalidateQueries({ queryKey: ["floor-editor-revisions", state.floor.siteId, state.floor.id] })
  ]);
}
