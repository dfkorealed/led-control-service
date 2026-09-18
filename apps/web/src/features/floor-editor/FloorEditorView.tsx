import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Hand, Minus, MousePointer2, RotateCcw, Save, Square, Triangle, TriangleAlert, Type, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Focus } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AuthUser } from "../../api/auth";
import { ApiError } from "../../api/client";
import { Button, Checkbox, ConfirmDialog, FeedbackState, Heading, IconButton, PageHeader, SelectBox, SidePanel, Text } from "../../components/ui";
import {
  listFloorEditorRevisions,
  getAppliedFloorImportOverlay,
  getFloorEditorState,
  restoreFloorEditorRevision,
  saveFloorEditorState,
  type FloorEditorRevision
} from "../../api/floor-editor";
import { EditorPropertiesPanel } from "./EditorPropertiesPanel";
import { createFixturePlacementRowRegistry, FixturePlacementList } from "./FixturePlacementList";
import { EditorBatchPlacementPanel } from "./EditorBatchPlacementPanel";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { FixtureIdentifyPanel } from "./FixtureIdentifyPanel";
import { CadImportPanel } from "./CadImportPanel";
import { loadEditorDraft, removeEditorDraft, saveEditorDraft, editorDraftGeneration } from "./editor-drafts";
import { authMeQueryKey } from "../../api/principal-cache";
import { FloorEditorCanvas } from "./FloorEditorCanvas";
import { buildEditorChanges } from "./editor-diff";
import { synchronizeMonitoringCaches } from "./editor-monitoring-cache";
import { useFloorEditorStore } from "./editor-store";
import type { CadImportReviewState, EditorTool, FloorEditorState, FloorImportApplyResult } from "./editor-types";

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
  const { initialState: baseline, state, isDirty, activeTool, zoom, initialize, adoptBaseline, setActiveTool, setZoom, resetZoom, past, future, snap, selection, selectedFixtureIds } = useFloorEditorStore(useShallow((s) => ({ initialState: s.initialState, state: s.state, isDirty: s.isDirty, activeTool: s.activeTool, zoom: s.zoom, initialize: s.initialize, adoptBaseline: s.adoptBaseline, setActiveTool: s.setActiveTool, setZoom: s.setZoom, resetZoom: s.resetZoom, past: s.past, future: s.future, snap: s.snap, selection: s.selection, selectedFixtureIds: s.selectedFixtureIds })));
  const [panelTab, setPanelTab] = useState("properties");
  const [recovery, setRecovery] = useState<FloorEditorState | null>(null);
  const [draftError, setDraftError] = useState(false);
  const userId = queryClient.getQueryData<{ user: AuthUser }>(authMeQueryKey)?.user.id;
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error" | "conflict">("idle");
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [isCadImportPending, setIsCadImportPending] = useState(false);
  const [cadImportReview, setCadImportReview] = useState<CadImportReviewState | null>(null);
  const [focusedCadCandidateId, setFocusedCadCandidateId] = useState<string | null>(null);
  const [skippedFixtureCount, setSkippedFixtureCount] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  const rowRegistry = useMemo(createFixturePlacementRowRegistry, []);
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
  const overlayRevision = state?.floor.id === floorId && state.floor.siteId === siteId
    ? state.floor.mapRevision
    : initialState.floor.mapRevision;
  const appliedOverlayQuery = useQuery({
    queryKey: ["floor-import-applied-overlay", siteId, floorId, overlayRevision],
    queryFn: () => getAppliedFloorImportOverlay(floorId)
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

  useEffect(() => {
    setPanelTab("properties");
  }, [selection?.kind, selection?.id, selectedFixtureIds.length]);

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

  const handleCadBusyChange = useCallback((busy: boolean) => {
    mutationLock.current = busy;
    setIsCadImportPending(busy);
  }, []);

  const handleCadApplied = useCallback(async (_result: FloorImportApplyResult | null) => {
    const authoritative = await getFloorEditorState(floorId);
    if (authoritative.floor.id !== floorId || authoritative.floor.siteId !== siteId) {
      throw new Error("Editor response scope mismatch");
    }
    if (userId && baseline) removeEditorDraft(userId, baseline);
    adoptBaseline(authoritative);
    await invalidateEditorQueries(queryClient, authoritative);
    await onSaved(authoritative);
  }, [adoptBaseline, baseline, floorId, onSaved, queryClient, siteId, userId]);

  const toggleCadCandidate = useCallback((candidateId: string) => {
    setCadImportReview((current) => {
      if (!current) return current;
      const accepted = new Set(current.acceptedCandidateIds);
      if (accepted.has(candidateId)) accepted.delete(candidateId);
      else accepted.add(candidateId);
      return { ...current, acceptedCandidateIds: [...accepted] };
    });
  }, []);

  const revisions = revisionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const appliedOverlay = appliedOverlayQuery.data?.overlay;
  const currentAppliedOverlay = appliedOverlay && state
    && appliedOverlay.floorId === floorId
    && appliedOverlay.revision === state.floor.mapRevision
    && appliedOverlay.renderedAssetPath === state.floor.floorPlan?.imageUrl
    ? appliedOverlay
    : null;
  const visibleCadCandidates = cadImportReview?.candidates ?? currentAppliedOverlay?.candidates ?? [];
  const visibleCadViewport = cadImportReview?.job.renderedViewport ?? currentAppliedOverlay?.renderedViewport;
  const visibleCadBackgroundUrl = cadImportReview?.job.renderedAssetPath ?? currentAppliedOverlay?.renderedAssetPath;
  const acceptedCadCandidateIds = useMemo(() => new Set(
    cadImportReview?.acceptedCandidateIds ?? currentAppliedOverlay?.candidates.map(candidate => candidate.id) ?? []
  ), [cadImportReview?.acceptedCandidateIds, currentAppliedOverlay?.candidates]);
  const isMutationPending = saveStatus === "saving" || restoringRevision !== null || isCadImportPending;
  const isSaveOrRestoreBlocked = readOnly || isMutationPending || state?.floor.id !== floorId;

  return (
    <section className="grid min-w-0 gap-3.5">
      <PageHeader
        title={`${initialState.floor.name} 맵 편집`}
        description={`리비전 ${baseline?.floor.mapRevision ?? initialState.floor.mapRevision}${isDirty ? " · 저장하지 않은 변경사항" : " · 저장됨"}`}
        actions={(
          <div className="flex flex-wrap items-center justify-end gap-2 max-compact:w-full max-compact:justify-start">
            {floors && onFloorChange && <SelectBox label="층 선택" className="min-w-32" items={floors.map((floor) => ({ id: floor.id, label: floor.name }))} selectedKey={floorId} isDisabled={isMutationPending} onSelectionChange={(key) => { if (key && !mutationLock.current) onFloorChange(key); }} />}
            <IconButton variant="ghost" className="max-compact:h-14 max-compact:min-h-14 max-compact:w-14 max-compact:min-w-14" aria-label="실행 취소" title="실행 취소" disabled={isSaveOrRestoreBlocked || !past.length} onClick={() => useFloorEditorStore.getState().undo()}><Undo2 size={18} /></IconButton>
            <IconButton variant="ghost" className="max-compact:h-14 max-compact:min-h-14 max-compact:w-14 max-compact:min-w-14" aria-label="다시 실행" title="다시 실행" disabled={isSaveOrRestoreBlocked || !future.length} onClick={() => useFloorEditorStore.getState().redo()}><Redo2 size={18} /></IconButton>
            <IconButton variant="ghost" className="max-compact:h-14 max-compact:min-h-14 max-compact:w-14 max-compact:min-w-14" aria-label="축소" onClick={() => setZoom(zoom - 0.1)}>
              <ZoomOut size={18} aria-hidden="true" />
            </IconButton>
            <Button variant="secondary" className="min-w-16" aria-label="100%" title="100%" onClick={resetZoom}>{Math.round(zoom * 100)}%</Button>
            <IconButton variant="ghost" className="max-compact:h-14 max-compact:min-h-14 max-compact:w-14 max-compact:min-w-14" aria-label="확대" onClick={() => setZoom(zoom + 0.1)}>
              <ZoomIn size={18} aria-hidden="true" />
            </IconButton>
            <IconButton variant="ghost" className="max-compact:h-14 max-compact:min-h-14 max-compact:w-14 max-compact:min-w-14" aria-label="맵 맞춤" title="맵 맞춤" onClick={() => useFloorEditorStore.getState().fit(false, visibleCadViewport ?? undefined)}><Maximize size={18} /></IconButton>
            <IconButton variant="ghost" className="max-compact:h-14 max-compact:min-h-14 max-compact:w-14 max-compact:min-w-14" aria-label="선택 맞춤" title="선택 맞춤" onClick={() => useFloorEditorStore.getState().fit(true)}><Focus size={18} /></IconButton>
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
          title="최신 맵과 변경사항이 충돌했습니다."
          description="최신 버전을 다시 불러온 뒤 변경사항을 확인하세요."
          action={<Button variant="secondary" onClick={() => {
            if (!isDirty) { void onReload(); return; }
            setConfirmReload(true);
          }}>최신 버전 다시 불러오기</Button>}
        />
      ) : null}
      {recovery && <FeedbackState icon={TriangleAlert} tone="warning" title="저장하지 않은 로컬 초안이 있습니다." action={<div className="flex flex-wrap justify-end gap-2"><Button disabled={isSaveOrRestoreBlocked} onClick={() => { if (readOnly || mutationLock.current || recovery.floor.id !== activeScope.current.floorId) return; useFloorEditorStore.getState().recoverDraft(recovery); setRecovery(null); }}>초안 복구</Button><Button disabled={isMutationPending} onClick={() => { if (userId) removeEditorDraft(userId, initialState); setRecovery(null); }}>초안 삭제</Button></div>} />}
      {draftError && <FeedbackState icon={TriangleAlert} tone="warning" title="이 브라우저에 초안을 보관하지 못했습니다. 서버에 저장하세요." />}
      {skippedFixtureCount > 0 ? (
        <FeedbackState tone="success" icon={CircleCheck} title={`현재 존재하지 않는 조명 ${skippedFixtureCount}개를 건너뛰었습니다.`} />
      ) : null}

      <div className="grid h-[max(620px,calc(100vh-230px))] min-h-155 grid-cols-12 gap-3 max-compact:h-auto max-compact:min-h-0 max-compact:grid-cols-1" data-testid="floor-editor-layout">
        <div className="col-span-3 flex min-h-0 min-w-0 flex-col border-r border-border-default bg-surface-panel max-compact:col-span-full max-compact:border-r-0 tablet:col-span-2"><FixturePlacementList readOnly={readOnly || isMutationPending} rowRegistry={rowRegistry} />
        <aside className="grid grid-cols-4 content-start gap-2 p-2 max-compact:grid-cols-3" role="toolbar" aria-label="맵 편집 도구">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Button
                key={tool.key}
                variant="ghost"
                className={`h-12 min-h-12 w-12 min-w-12 p-0 max-compact:h-14 max-compact:min-h-14 max-compact:w-14 max-compact:min-w-14 ${activeTool === tool.key ? "border-action-primary bg-action-primary-soft text-action-primary" : ""}`}
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
        </aside><Checkbox className="m-2" label="격자 스냅" isSelected={snap} isDisabled={readOnly} onChange={(selected) => useFloorEditorStore.getState().setSnap(selected)} /></div>
        <main className="col-span-6 grid min-w-0 overflow-hidden border border-border-default bg-surface-inset max-compact:col-span-full max-compact:h-120 tablet:col-span-7">
          <FloorEditorCanvas
            readOnly={readOnly || isMutationPending}
            rowRegistry={rowRegistry}
            cadCandidates={visibleCadCandidates}
            cadBackgroundUrl={visibleCadBackgroundUrl}
            cadViewport={visibleCadViewport}
            acceptedCadCandidateIds={acceptedCadCandidateIds}
            focusedCadCandidateId={focusedCadCandidateId}
            onFocusedCadCandidateChange={setFocusedCadCandidateId}
            onToggleCadCandidate={cadImportReview && !readOnly ? toggleCadCandidate : undefined}
          />
        </main>
        <SidePanel className="col-span-3 grid min-w-0 content-start gap-3 overflow-y-auto p-0 max-compact:col-span-full" aria-label="맵 편집 정보">
          <div className="grid grid-cols-3 gap-1 bg-surface-inset p-1" role="tablist" aria-label="편집 패널">{[["properties", "속성"], ["placement", "배치"], ["layers", "레이어"]].map(([value, label]) => <Button size="sm" variant={panelTab === value ? "primary" : "ghost"} role="tab" key={value} aria-selected={panelTab === value} onClick={() => setPanelTab(value)}>{label}</Button>)}</div>
          {panelTab === "properties" && <EditorPropertiesPanel readOnly={readOnly || isMutationPending} />}
          {panelTab === "placement" && <EditorBatchPlacementPanel readOnly={readOnly || isMutationPending} />}
          {panelTab === "layers" && <EditorLayersPanel readOnly={readOnly || isMutationPending} />}
          <CadImportPanel
            floorId={floorId}
            expectedRevision={baseline?.floor.mapRevision ?? initialState.floor.mapRevision}
            leaseToken={leaseToken}
            leaseFence={leaseFence}
            disabled={readOnly || saveStatus === "saving" || restoringRevision !== null}
            isDirty={isDirty}
            review={cadImportReview}
            focusedCandidateId={focusedCadCandidateId}
            onReviewChange={(next) => {
              setCadImportReview(next);
              if (!next) setFocusedCadCandidateId(null);
            }}
            onFocusedCandidateChange={setFocusedCadCandidateId}
            onBusyChange={handleCadBusyChange}
            onApplied={handleCadApplied}
            onConflict={() => setSaveStatus("conflict")}
          />
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
        </SidePanel>
      </div>
      {confirmReload ? <ConfirmDialog
        title="로컬 변경사항을 버릴까요?"
        confirmLabel="변경사항 버리기"
        destructive
        onCancel={() => setConfirmReload(false)}
        onConfirm={() => {
          useFloorEditorStore.getState().discardChanges();
          setConfirmReload(false);
          void onReload();
        }}
      ><Text>최신 버전을 불러오면 저장하지 않은 변경사항을 복구할 수 없습니다.</Text></ConfirmDialog> : null}
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
    <section className="grid gap-3 border-t border-border-subtle p-3" aria-label="맵 버전">
      <div className="grid gap-1">
        <Text variant="overline" tone="secondary">버전</Text>
        <Heading as="h3" variant="card-title">변경 기록</Heading>
      </div>
      {isLoading ? <Text variant="body-sm" tone="secondary" role="status">버전 기록을 불러오는 중</Text> : null}
      {isError ? (
        <div className="grid gap-2" role="alert">
          <Text variant="body-sm" tone="danger">버전 기록을 불러오지 못했습니다.</Text>
          <Button variant="secondary" onClick={onRetry}>다시 시도</Button>
        </div>
      ) : null}
      {!isLoading && !isError && revisions.length === 0 ? <Text variant="body-sm" tone="secondary">저장된 버전이 없습니다.</Text> : null}
      {!isLoading && !isError && revisions.length > 0 ? (
        <ol className="grid list-none gap-0 p-0" data-testid="editor-revision-list">
          {revisions.map((revision) => (
            <li className="flex items-center justify-between gap-2.5 border-t border-border-default py-2.5 first:border-t-0 first:pt-0" key={revision.revision}>
              <div className="grid min-w-0 gap-0.5">
                <Text as="strong" variant="body-sm" weight="semibold">리비전 {revision.revision}</Text>
                <Text as="span" variant="caption" tone="secondary">{revision.actor.displayName}</Text>
                <Text as="time" variant="caption" tone="secondary" dateTime={revision.createdAt}>{formatRevisionTime(revision.createdAt)}</Text>
                <Text as="span" variant="caption" tone="secondary">변경 {revisionChangeCount(revision.changeSummary)}건</Text>
              </div>
              {canRestore ? (
                <IconButton
                  variant="ghost"
                  className="h-14 min-h-14 w-14 min-w-14"
                  aria-label={`리비전 ${revision.revision} 복구`}
                  title="이 버전 복구"
                  disabled={isDirty || isMutationPending}
                  onClick={() => onRestore(revision.revision)}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                </IconButton>
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
  synchronizeMonitoringCaches(queryClient, state);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["dashboard", state.floor.siteId] }),
    queryClient.invalidateQueries({ queryKey: ["floor-fixtures", state.floor.siteId, state.floor.id] }),
    queryClient.invalidateQueries({ queryKey: ["floor-map", state.floor.siteId, state.floor.id] }),
    queryClient.invalidateQueries({ queryKey: ["floor-editor-revisions", state.floor.siteId, state.floor.id] })
  ]);
}
