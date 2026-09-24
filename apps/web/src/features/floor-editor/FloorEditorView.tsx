import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { CircleCheck, PanelLeft, PanelRight, RotateCcw, Save, TriangleAlert, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Focus, X } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AuthUser } from "../../api/auth";
import { ApiError } from "../../api/client";
import { Button, Checkbox, ConfirmDialog, FeedbackState, Heading, IconButton, IconTooltipButton, SelectBox, SidePanel, Text } from "../../components/ui";
import {
  listFloorEditorRevisions,
  getAppliedFloorImportOverlay,
  getFloorEditorState,
  restoreFloorEditorRevision,
  type FloorEditorRevision
} from "../../api/floor-editor";
import { EditorPropertiesPanel } from "./EditorPropertiesPanel";
import { MobileFixturePlacementBar } from "./MobileFixturePlacementBar";
import { createFixturePlacementRowRegistry, FIXTURE_DRAG_TYPE, FixturePlacementList } from "./FixturePlacementList";
import { EditorBatchPlacementPanel } from "./EditorBatchPlacementPanel";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { FixtureIdentifyPanel } from "./FixtureIdentifyPanel";
import { CadImportPanel } from "./CadImportPanel";
import { loadEditorDraft, removeEditorDraft, saveEditorDraft, editorDraftGeneration } from "./editor-drafts";
import { authMeQueryKey } from "../../api/principal-cache";
import { FloorEditorCanvas } from "./FloorEditorCanvas";
import { EditorToolPalette } from "./EditorToolPalette";
import { useMapEditor } from "./use-map-editor";
import { MapElementPropertiesPanel } from "./MapElementPropertiesPanel";
import { MapSelectionProperties } from "./MapSelectionProperties";
import { MapDocumentInitialization } from "./MapDocumentInitialization";
import { MapPolygonControls } from "./MapPolygonControls";
import { synchronizeMonitoringCaches } from "./editor-monitoring-cache";
import { useFloorEditorStore } from "./editor-store";
import type { CadImportReviewState, FloorEditorState, FloorImportApplyResult } from "./editor-types";
import { snapPointToGridWithinBounds, type Point } from "./geometry";

import { useCadImportScene } from "./CadImportSceneCanvas";

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
  readOnly ||= userRole !== "admin" || !leaseToken || !leaseFence;
  const queryClient = useQueryClient();
  const { initialState: baseline, state, isDirty, activeTool, zoom, initialize, adoptBaseline, setActiveTool, setZoom, resetZoom, past, future, snap, selection, cadSelection, selectedFixtureIds } = useFloorEditorStore(useShallow((s) => ({ initialState: s.initialState, state: s.state, isDirty: s.isDirty, activeTool: s.activeTool, zoom: s.zoom, initialize: s.initialize, adoptBaseline: s.adoptBaseline, setActiveTool: s.setActiveTool, setZoom: s.setZoom, resetZoom: s.resetZoom, past: s.past, future: s.future, snap: s.snap, selection: s.selection, cadSelection: s.cadSelection, selectedFixtureIds: s.selectedFixtureIds })));
  const [panelTab, setPanelTab] = useState("properties");
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => window.matchMedia?.("(max-width: 1279px)").matches ?? false);
  const [openPanel, setOpenPanel] = useState<"tools" | "information" | null>(null);
  const [placementDraft, setPlacementDraft] = useState<{ floorId: string; siteId: string; fixtureId: string; point: Point | null } | null>(null);
  const [isToolPanelDragging, setIsToolPanelDragging] = useState(false);
  const panelDragSource = useRef<HTMLElement | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState({ tools: false, information: false });
  const toolsToggle = useRef<HTMLButtonElement>(null);
  const informationToggle = useRef<HTMLButtonElement>(null);
  const toolsPanel = useRef<HTMLDivElement>(null);
  const informationPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    // Non-visual hosts have no media queries; keep the complete panel layout.
    const media = window.matchMedia?.("(max-width: 1279px)");
    if (!media) return;
    const update = () => { setIsNarrowLayout(media.matches); setOpenPanel(null); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const toolsVisible = isNarrowLayout ? openPanel === "tools" : !collapsedPanels.tools;
  const informationVisible = isNarrowLayout ? openPanel === "information" : !collapsedPanels.information;
  function beginPanelDrag(event: DragEvent<HTMLDivElement>) {
    if (!isNarrowLayout || event.defaultPrevented || !(event.target instanceof HTMLElement)
      || !event.dataTransfer.types.some((type) => type === FIXTURE_DRAG_TYPE || type === TOOL_DRAG_DATA_TYPE)) return;
    const source = event.target;
    panelDragSource.current = source;
    // Let the browser establish native DnD and capture its drag image before
    // changing hit testing beneath the pointer that initiated the drag.
    requestAnimationFrame(() => {
      if (panelDragSource.current === source) setIsToolPanelDragging(true);
    });
  }
  function finishPanelDrag() {
    const source = panelDragSource.current;
    if (!source) return;
    panelDragSource.current = null;
    setIsToolPanelDragging(false);
    // A placed fixture leaves the unplaced list on drop. Wait for that commit
    // before choosing the still-live source or the restored panel as focus target.
    requestAnimationFrame(() => {
      (source.isConnected ? source : toolsPanel.current)?.focus({ preventScroll: true });
    });
  }
  function togglePanel(panel: "tools" | "information") {
    if (isNarrowLayout) setOpenPanel((current) => current === panel ? null : panel);
    else setCollapsedPanels((current) => ({ ...current, [panel]: !current[panel] }));
  }
  function closePanel(panel: "tools" | "information") {
    if (isNarrowLayout) setOpenPanel(null);
    else setCollapsedPanels((current) => ({ ...current, [panel]: true }));
    (panel === "tools" ? toolsToggle : informationToggle).current?.focus();
  }
  useEffect(() => {
    if (openPanel) (openPanel === "tools" ? toolsPanel : informationPanel).current?.focus();
  }, [openPanel]);
  const [recovery, setRecovery] = useState<ReturnType<typeof loadEditorDraft>>(null);
  const [draftError, setDraftError] = useState(false);
  const userId = queryClient.getQueryData<{ user: AuthUser }>(authMeQueryKey)?.user.id;
  // A purge invalidates this mounted session; it must not initialize stale
  // authorized props again merely because the global draft generation changed.
  const draftScope = useMemo(() => `${userId ?? "session"}:${editorDraftGeneration()}:${userRole}`, [userId, userRole]);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error" | "conflict">("idle");
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [isCadImportPending, setIsCadImportPending] = useState(false);
  const [isResetPending, setIsResetPending] = useState(false);
  const [importReview, setCadImportReview] = useState<CadImportReviewState | null>(null);
  const cadImportReview = importReview?.job.floorId === initialState.floor.id ? importReview : null;
  const [focusedCadCandidateId, setFocusedCadCandidateId] = useState<string | null>(null);
  const [skippedFixtureCount, setSkippedFixtureCount] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  const rowRegistry = useMemo(createFixturePlacementRowRegistry, []);
  const mutationLock = useRef(false);
  const activeInstance = useRef(true);
  const activeScope = useRef({ floorId: initialState.floor.id, siteId: initialState.floor.siteId, authScope: draftScope });
  activeScope.current = { floorId: initialState.floor.id, siteId: initialState.floor.siteId, authScope: draftScope };
  useLayoutEffect(() => { activeInstance.current = true; return () => { activeInstance.current = false; }; }, []);
  const noticeFloorId = useRef(initialState.floor.id);
  const floorId = initialState.floor.id;
  const siteId = initialState.floor.siteId;
  const importSceneQuery = useCadImportScene(floorId, cadImportReview);
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
  const lease = useMemo(() => leaseToken && leaseFence ? { leaseToken, leaseFence } : undefined, [leaseToken, leaseFence]);
  const map = useMapEditor({ floorId, authScope: draftScope, readOnly, lease });
  const stageProgress = useFloorEditorStore(s => s.stageProgress);
  const fixtureLayer = useFloorEditorStore(s => s.layers.fixtures);
  const lockedFixtureIds = useFloorEditorStore(s => s.lockedFixtureIds);

  useLayoutEffect(() => {
    const current = useFloorEditorStore.getState();
    if (current.state === initialState) return;
    const sameScope = current.state?.floor.id === initialState.floor.id && current.state.floor.siteId === initialState.floor.siteId;
    if (sameScope && current.isDirty) return;
    const incoming = initialState.floor.mapDocument;
    const acknowledged = current.initialState?.floor;
    // Normal save already ACKs the common store. Query structural sharing may
    // clone that response; adopting it again would initialize away its history.
    if (sameScope && incoming && current.mapScope?.authScope === draftScope
      && current.mapScope.generationId === incoming.generationId && current.mapScope.baseRevision === incoming.revision
      && acknowledged?.mapRevision === initialState.floor.mapRevision
      && acknowledged.mapDocument?.generationId === incoming.generationId && acknowledged.mapDocument.revision === incoming.revision) return;
    // Query cache structural sharing can change response identity after a save.
    // Legacy refresh preserves history; a different common revision/generation
    // still takes the explicit baseline-adoption path.
    if (sameScope) adoptBaseline(initialState, true);
    else initialize(initialState, draftScope);
    if (!mutationLock.current) setSaveStatus("idle");
    if (noticeFloorId.current !== initialState.floor.id) {
      noticeFloorId.current = initialState.floor.id;
      setSkippedFixtureCount(0);
    }
  }, [initialState, initialize, adoptBaseline, draftScope]);

  useEffect(() => {
    if (!userId || !baseline || baseline.floor.id !== floorId || baseline.floor.siteId !== siteId) return;
    // Store ACK is authoritative even when a parent callback has not delivered
    // new query props yet (including a committed cancellation receipt).
    const currentBaseline = baseline;
    setRecovery(loadEditorDraft(draftScope, currentBaseline));
    setDraftError(false);
    const generation = editorDraftGeneration();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      if (generation !== editorDraftGeneration()) return;
      const store = useFloorEditorStore.getState();
      if (store.isDirty && store.state?.floor.id === currentBaseline.floor.id && store.initialState?.floor.mapRevision === currentBaseline.floor.mapRevision) {
        const draft = store.exportMapDraft();
        // An unfinished upload has no durable stage ref; its retry/cancel UI owns
        // that state. It must not masquerade as a localStorage quota failure.
        if (store.state.floor.mapDocument && !draft) return;
        setDraftError(!saveEditorDraft(draftScope, currentBaseline, store.state, draft, generation));
      }
    };
    const unsubscribe = useFloorEditorStore.subscribe((next, previous) => {
      if (next.state === previous.state && next.mapOperations === previous.mapOperations) return;
      clearTimeout(timer);
      if (!next.isDirty && previous.isDirty) {
        removeEditorDraft(draftScope, currentBaseline);
        setDraftError(false);
      }
      else timer = setTimeout(persist, 300);
    });
    window.addEventListener("pagehide", persist);
    window.addEventListener("beforeunload", persist);
    return () => { clearTimeout(timer); persist(); unsubscribe(); window.removeEventListener("pagehide", persist); window.removeEventListener("beforeunload", persist); };
  }, [userId, draftScope, baseline, floorId, siteId]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    setPanelTab((current) => current === "details" ? current : "properties");
  }, [selection?.kind, selection?.id, cadSelection?.targetId, selectedFixtureIds.length]);

  function isCurrentSave(principalGeneration: number) {
    return activeInstance.current && principalGeneration === editorDraftGeneration()
      && activeScope.current.floorId === floorId && activeScope.current.siteId === siteId
      && activeScope.current.authScope === draftScope
      && useFloorEditorStore.getState().initialState?.floor.id === floorId;
  }

  function captureSaveAcknowledgement(principalGeneration: number) {
    const renderer = map.handle.current;
    const version = renderer?.getDraftVersion();
    const generationId = state?.floor.mapDocument?.generationId;
    const wasStagePreview = Boolean(useFloorEditorStore.getState().pendingMapStage);
    return async () => {
      if (!isCurrentSave(principalGeneration)) return;
      const saved = useFloorEditorStore.getState().initialState!;
      if (saved.floor.id !== floorId || saved.floor.siteId !== siteId) throw new Error("Editor response scope mismatch");
      if (!wasStagePreview && renderer && version !== undefined && saved.floor.mapDocument?.generationId === generationId) {
        // Renderer refresh failure must not turn an acknowledged store save into an unsaved retry.
        await renderer.acknowledge(saved.floor.mapDocument!, version).catch(map.reportError);
      }
      if (!isCurrentSave(principalGeneration)) return;
      if (!useFloorEditorStore.getState().isDirty) {
        if (userId && baseline) removeEditorDraft(draftScope, baseline);
        setDraftError(false);
      }
      await invalidateEditorQueries(queryClient, saved);
      if (isCurrentSave(principalGeneration)) await onSaved(saved);
    };
  }

  async function handleCancelStage() {
    if (readOnly || mutationLock.current) return;
    mutationLock.current = true;
    const principalGeneration = editorDraftGeneration();
    try {
      const acknowledge = captureSaveAcknowledgement(principalGeneration);
      const result = await map.cancelStage();
      if (!isCurrentSave(principalGeneration)) return;
      if (result === "committed") await acknowledge();
      if (isCurrentSave(principalGeneration) && (result === "committed" || result === "cancelled")) setSaveStatus("idle");
    } catch (error) {
      if (isCurrentSave(principalGeneration)) { map.reportError(error); setSaveStatus("error"); }
    } finally { mutationLock.current = false; }
  }

  async function handleSave() {
    if (readOnly || !state || !baseline || state.floor.id !== floorId || baseline.floor.id !== floorId || state.floor.siteId !== siteId || !isDirty || mutationLock.current || !leaseToken || !leaseFence) return;
    mutationLock.current = true;
    const principalGeneration = editorDraftGeneration();
    const stillCurrent = () => isCurrentSave(principalGeneration);
    setSaveStatus("saving");
    setSkippedFixtureCount(0);
    try {
      const acknowledge = captureSaveAcknowledgement(principalGeneration);
      const result = await useFloorEditorStore.getState().saveChanges({ leaseToken, leaseFence });
      if (result === "stale") return;
      await acknowledge();
      if (!stillCurrent()) return;
    } catch (error) {
      if (!stillCurrent()) return;
      if (error instanceof Error && "code" in error) map.reportError(error);
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

  const handleCadBusyChange = useCallback((busy: boolean) => {
    mutationLock.current = busy;
    setIsCadImportPending(busy);
  }, []);
  const handleResetBusyChange = useCallback((busy: boolean) => {
    mutationLock.current = busy;
    setIsResetPending(busy);
  }, []);

  const handleCadApplied = useCallback(async (_result: FloorImportApplyResult | null) => {
    const authoritative = await getFloorEditorState(floorId);
    if (authoritative.floor.id !== floorId || authoritative.floor.siteId !== siteId) {
      throw new Error("Editor response scope mismatch");
    }
    if (userId && baseline) removeEditorDraft(draftScope, baseline);
    adoptBaseline(authoritative);
    await invalidateEditorQueries(queryClient, authoritative);
    await onSaved(authoritative);
  }, [adoptBaseline, baseline, draftScope, floorId, onSaved, queryClient, siteId, userId]);

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
  const nativeReview = cadImportReview && cadImportReview.scene?.kind !== "legacy";
  const visibleCadCandidates = nativeReview
    ? importSceneQuery.data ? cadImportReview.candidates : []
    : cadImportReview?.candidates ?? currentAppliedOverlay?.candidates ?? [];
  const visibleCadViewport = nativeReview ? importSceneQuery.data
    : cadImportReview?.job.renderedViewport ?? currentAppliedOverlay?.renderedViewport;
  const visibleCadBackgroundUrl = nativeReview ? ""
    : cadImportReview?.job.renderedAssetPath ?? currentAppliedOverlay?.renderedAssetPath;
  const acceptedCadCandidateIds = useMemo(() => new Set(
    cadImportReview?.acceptedCandidateIds ?? currentAppliedOverlay?.candidates.map(candidate => candidate.id) ?? []
  ), [cadImportReview?.acceptedCandidateIds, currentAppliedOverlay?.candidates]);
  const cadResetSummary = useMemo(() => ({
    fixtureCount: state?.floor.id === floorId ? state.fixtures.length : initialState.fixtures.length,
    objectCount: state?.floor.id === floorId ? state.objects.length : initialState.objects.length,
    slotCount: state?.floor.id === floorId ? state.lightSlots.length : initialState.lightSlots.length
  }), [floorId, initialState.fixtures.length, initialState.lightSlots.length, initialState.objects.length, state]);
  const isMutationPending = saveStatus === "saving" || restoringRevision !== null || isCadImportPending || isResetPending || map.preparing;
  const isSaveOrRestoreBlocked = readOnly || isMutationPending || state?.floor.id !== floorId;
  const placementFixture = placementDraft && isNarrowLayout && Boolean(map.document) && !readOnly && !isMutationPending && !cadImportReview
    && Boolean(leaseToken && leaseFence)
    && activeTool === "select" && !map.holeActive
    && state?.floor.id === floorId && state.floor.siteId === siteId
    && placementDraft.floorId === floorId && placementDraft.siteId === siteId
    && fixtureLayer.visible && !fixtureLayer.locked && !lockedFixtureIds.includes(placementDraft.fixtureId)
    ? state.fixtures.find((fixture) => fixture.id === placementDraft.fixtureId && fixture.placementStatus === "unplaced") : null;
  const placementBounds = map.mapBounds ?? {
    width: state?.floor.floorPlan?.width ?? state?.floor.mapDocument?.width ?? 1200,
    height: state?.floor.floorPlan?.height ?? state?.floor.mapDocument?.height ?? 800
  };
  useEffect(() => {
    if (placementDraft && !placementFixture) setPlacementDraft(null);
  }, [placementDraft, placementFixture]);

  function updatePlacementPoint(fixtureId: string, point: Point | null) {
    const gridSize = state?.floor.mapDocument?.gridSize ?? state?.floor.floorPlan?.gridSize ?? 10;
    const next = point && snap ? snapPointToGridWithinBounds(point, gridSize, placementBounds) : point;
    setPlacementDraft((current) => current && current.fixtureId === fixtureId && current.floorId === floorId && current.siteId === siteId
      ? { ...current, point: next } : current);
  }

  function confirmPlacement() {
    if (!placementDraft?.point || !placementFixture || !leaseToken || !leaseFence) return;
    const current = useFloorEditorStore.getState();
    const fixture = current.state?.fixtures.find((item) => item.id === placementDraft.fixtureId);
    if (current.state?.floor.id !== floorId || current.state.floor.siteId !== siteId || fixture?.placementStatus !== "unplaced"
      || !current.layers.fixtures.visible || current.layers.fixtures.locked || current.lockedFixtureIds.includes(placementDraft.fixtureId)) return;
    const { x, y } = placementDraft.point;
    if (x < 0 || y < 0 || x > placementBounds.width || y > placementBounds.height) return;
    current.placeFixtures([{ id: placementDraft.fixtureId, x, y }]);
    current.selectFixture(placementDraft.fixtureId);
    setPlacementDraft(null);
    toolsToggle.current?.focus();
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden">
      <header className="shrink-0 [&_[role=tooltip]]:pointer-events-none" data-testid="editor-toolbar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <Heading as="h2" variant="card-title" className="truncate">{initialState.floor.name} 맵 편집</Heading>
            <Text variant="caption" tone="secondary">리비전 {baseline?.floor.mapRevision ?? initialState.floor.mapRevision}{isDirty ? " · 저장하지 않은 변경사항" : " · 저장됨"}</Text>
          </div>
          <div className="flex min-w-0 items-center gap-1">
            {floors && onFloorChange && <SelectBox label="층 선택" className="w-32 min-w-0 [&>label]:sr-only" items={floors.map((floor) => ({ id: floor.id, label: floor.name }))} selectedKey={floorId} isDisabled={isMutationPending} onSelectionChange={(key) => { if (key && !mutationLock.current) onFloorChange(key); }} />}
            <IconTooltipButton icon={X} label="취소" onClick={onCancel} />
            <IconTooltipButton className="bg-action-primary text-content-inverse hover:bg-action-primary-hover" icon={Save} label="저장" disabled={!isDirty || isSaveOrRestoreBlocked} isLoading={saveStatus === "saving"} loadingLabel="저장 중" onClick={handleSave} />
          </div>
        </div>
        <div className="flex flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-border-default py-1" role="toolbar" aria-label="맵 보기 도구">
          <IconTooltipButton ref={toolsToggle} icon={PanelLeft} label="도구 및 조명 패널" aria-expanded={toolsVisible} aria-controls="editor-tools-panel" onClick={() => togglePanel("tools")} />
          <IconTooltipButton icon={Undo2} label="실행 취소" disabled={isSaveOrRestoreBlocked || !past.length} onClick={() => void map.history("undo")} />
          <IconTooltipButton icon={Redo2} label="다시 실행" disabled={isSaveOrRestoreBlocked || !future.length} onClick={() => void map.history("redo")} />
          <IconTooltipButton icon={ZoomOut} label="축소" onClick={() => setZoom(zoom / 1.1)} />
          <Button variant="secondary" className="h-11 w-16 shrink-0 px-1" aria-label="100%" title="100%" onClick={resetZoom}>{Math.round(zoom * 100)}%</Button>
          <IconTooltipButton icon={ZoomIn} label="확대" onClick={() => setZoom(zoom * 1.1)} />
          <IconTooltipButton icon={Maximize} label="맵 맞춤" onClick={() => useFloorEditorStore.getState().fit(false, visibleCadViewport ?? undefined)} />
          <IconTooltipButton icon={Focus} label="선택 맞춤" onClick={() => map.document ? map.fitSelection() : useFloorEditorStore.getState().fit(true)} />
          <IconTooltipButton ref={informationToggle} icon={PanelRight} label="편집 정보 패널" aria-expanded={informationVisible} aria-controls="editor-information-panel" onClick={() => togglePanel("information")} />
        </div>
      </header>

      {!map.document && !cadImportReview && <MapDocumentInitialization state={initialState} readOnly={readOnly || isDirty || saveStatus === "saving" || restoringRevision !== null || isCadImportPending} leaseToken={leaseToken} leaseFence={leaseFence} onBusyChange={handleResetBusyChange}
        onInitialized={next => { adoptBaseline(next); void invalidateEditorQueries(queryClient, next); void onSaved(next); }} />}
      {saveStatus === "error" && !map.error ? (
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
      {recovery && <FeedbackState icon={TriangleAlert} tone="warning" title="저장하지 않은 로컬 초안이 있습니다." action={<div className="flex flex-wrap justify-end gap-2"><Button disabled={isSaveOrRestoreBlocked} onClick={async () => {
        if (readOnly || mutationLock.current || recovery.floor.id !== activeScope.current.floorId) return;
        try {
          if (recovery.commonMapDraft?.stage) {
            if (!lease) return;
            const result = await useFloorEditorStore.getState().recoverStageDraft(recovery, lease);
            if (result === "stale") return;
          } else useFloorEditorStore.getState().recoverDraft(recovery);
          setRecovery(null);
        } catch (error) { map.reportError(error); }
      }}>초안 복구</Button><Button disabled={isMutationPending} onClick={() => { if (userId) removeEditorDraft(draftScope, initialState); setRecovery(null); }}>초안 삭제</Button></div>} />}
      {(map.preparing || map.pendingStage || map.retryStage || stageProgress) && <FeedbackState icon={map.pendingStage ? CircleCheck : TriangleAlert}
        tone={map.pendingStage ? "success" : map.error ? "danger" : "warning"}
        title={map.preparing ? "대량 편집을 준비하고 있습니다." : map.pendingStage ? "대량 편집 준비 완료 · 저장 대기" : "대량 편집 준비가 중단되었습니다."}
        description={stageProgress ? `${stageProgress.partCount}개 조각 · ${(stageProgress.decodedBytes / 1048576).toFixed(1)} MiB` : undefined}
        action={<div className="flex flex-wrap gap-2">
          {!map.preparing && !map.pendingStage && map.retryStage && <Button disabled={readOnly || saveStatus === "saving"} onClick={() => void map.retryStage?.()}>대량 편집 다시 시도</Button>}
          <Button disabled={readOnly || saveStatus === "saving"} onClick={() => void handleCancelStage()}>대량 편집 취소</Button>
        </div>} />}
      {draftError && <FeedbackState icon={TriangleAlert} tone="warning" title="이 브라우저에 초안을 보관하지 못했습니다. 서버에 저장하세요." />}
      {map.error && <FeedbackState icon={TriangleAlert} tone="danger" title={map.error} action={<Button variant="secondary" onClick={() => { if (isDirty) setConfirmReload(true); else void onReload(); }}>다시 불러오기</Button>} />}
      {skippedFixtureCount > 0 ? (
        <FeedbackState tone="success" icon={CircleCheck} title={`현재 존재하지 않는 조명 ${skippedFixtureCount}개를 건너뛰었습니다.`} />
      ) : null}

      {/* Canvas errors must stay actionable above an open narrow panel. Bound
          that notice to 80px and reserve 96px including its existing top inset. */}
      <div className={`relative flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden ${isNarrowLayout ? "[&:has(main_[role=alert])>#editor-tools-panel]:top-16 [&:has(main_[role=alert])>#editor-tools-panel]:mt-8 [&:has(main_[role=alert])>#editor-information-panel]:top-16 [&:has(main_[role=alert])>#editor-information-panel]:mt-8" : ""}`} data-testid="floor-editor-layout" onDrop={finishPanelDrag}>
        {/* Keep panels mounted while collapsed: import jobs, form drafts and the
            fixture drag registry must outlive a layout-only visibility change. */}
        {/* Opacity/pointer-events expose the drop surface without removing or
            hiding the native drag source. dragend also restores cancelled drags;
            the workbench drop handler covers a placed source leaving its list. */}
        <div ref={toolsPanel} id="editor-tools-panel" tabIndex={-1} aria-label="도구 및 조명"
          onDragStart={beginPanelDrag} onDragEnd={finishPanelDrag}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (!panelDragSource.current) closePanel("tools"); } }}
          className={`${toolsVisible ? "flex" : "hidden"} ${isNarrowLayout ? "absolute inset-y-0 left-0 z-10 w-[min(280px,100%)] shadow-panel" : "w-60 shrink-0"} ${isToolPanelDragging ? "pointer-events-none opacity-0" : ""} min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain border-r border-border-default bg-surface-panel [&>aside]:flex-none [&>aside:first-child]:h-112`}><FixturePlacementList readOnly={readOnly || isMutationPending || (isNarrowLayout && !map.document)} rowRegistry={rowRegistry} onPlacementRequest={isNarrowLayout ? (fixtureId) => {
            const current = useFloorEditorStore.getState();
            const fixture = current.state?.fixtures.find((item) => item.id === fixtureId);
            if (!fixture || fixture.placementStatus !== "unplaced" || !map.document || !leaseToken || !leaseFence
              || current.state?.floor.id !== floorId || current.state.floor.siteId !== siteId
              || !current.layers.fixtures.visible || current.layers.fixtures.locked || current.lockedFixtureIds.includes(fixtureId)) return;
            setActiveTool("select");
            setPlacementDraft({ floorId, siteId, fixtureId, point: null });
            setOpenPanel(null);
          } : undefined} />
        <EditorToolPalette className="order-first p-2" activeTool={activeTool} readOnly={readOnly || !map.document} disabled={isMutationPending && !cadImportReview}
          onToolDragStart={(tool) => { useFloorEditorStore.getState().clearSelection(); setActiveTool(tool); }}
          onToolChange={(tool) => { useFloorEditorStore.getState().clearSelection(); setActiveTool(tool); if (isNarrowLayout) closePanel("tools"); }} /><Checkbox className="m-2" label="격자 스냅" isSelected={snap} isDisabled={readOnly} onChange={(selected) => useFloorEditorStore.getState().setSnap(selected)} /></div>
        {/* The auxiliary minimap folds with narrow panels instead of remaining
            keyboard-focusable underneath them; closing the panel restores it. */}
        <main className={`grid min-h-0 min-w-0 flex-1 overflow-hidden border border-border-default bg-surface-inset [&>div]:min-h-0 [&_[role=alert]]:max-h-20 [&_[role=alert]]:overflow-y-auto ${placementFixture ? "grid-rows-[minmax(0,1fr)_auto]" : ""} ${isNarrowLayout && openPanel ? "[&_canvas[role=button]]:hidden" : ""}`}>
          <FloorEditorCanvas
            readOnly={readOnly || isMutationPending}
            rowRegistry={rowRegistry}
            cadCandidates={visibleCadCandidates}
            cadBackgroundUrl={visibleCadBackgroundUrl}
            cadViewport={visibleCadViewport}
            cadReviewActive={Boolean(cadImportReview)}
            cadImportScene={nativeReview ? {
              floorId, jobId: cadImportReview.job.jobId, manifest: importSceneQuery.data ?? null,
              isError: importSceneQuery.isError, onRetry: () => void importSceneQuery.refetch()
            } : null}
            acceptedCadCandidateIds={acceptedCadCandidateIds}
            focusedCadCandidateId={focusedCadCandidateId}
            onFocusedCadCandidateChange={setFocusedCadCandidateId}
            onToggleCadCandidate={cadImportReview && !readOnly ? toggleCadCandidate : undefined}
            mapEditor={map}
            placementDraftPoint={placementFixture ? placementDraft?.point : null}
            onPlacementPointChange={placementFixture ? (point) => updatePlacementPoint(placementFixture.id, point) : undefined}
          />
          {placementFixture ? <MobileFixturePlacementBar key={placementFixture.id} fixtureName={placementFixture.name} point={placementDraft?.point ?? null} bounds={placementBounds}
            onPointChange={(point) => updatePlacementPoint(placementFixture.id, point)}
            onCancel={() => { setPlacementDraft(null); setOpenPanel("tools"); requestAnimationFrame(() => rowRegistry.focus(placementFixture.id)); }}
            onConfirm={confirmPlacement} /> : null}
        </main>
        <SidePanel ref={informationPanel} id="editor-information-panel" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePanel("information"); } }} className={`${informationVisible ? "grid" : "hidden"} ${isNarrowLayout ? "absolute inset-y-0 right-0 z-10 w-[min(320px,100%)] shadow-panel" : "w-72 shrink-0"} min-h-0 min-w-0 content-start gap-3 overflow-y-auto rounded-none border-0 border-l border-border-default p-0`} aria-label="맵 편집 정보">
          <div className="grid grid-cols-4 gap-1 bg-surface-inset p-1" role="tablist" aria-label="편집 패널">{[["properties", "속성"], ["placement", "배치"], ["layers", "레이어"], ["details", "자료"]].map(([value, label]) => <Button size="sm" className="h-13 min-h-13" variant={panelTab === value ? "primary" : "ghost"} role="tab" key={value} aria-selected={panelTab === value} onClick={() => setPanelTab(value)}>{label}</Button>)}</div>
          {panelTab === "properties" && (map.selectionCount && (!map.selection.length || map.mixed)
            ? <MapSelectionProperties key={JSON.stringify([map.selectionKey, map.bounds])} editor={map} readOnly={readOnly || isMutationPending} />
            : map.selection.length
            ? <MapElementPropertiesPanel selection={map.selection} mapBounds={map.mapBounds ?? undefined} readOnly={readOnly || isMutationPending} locked={map.locked} onChange={map.commit} onDelete={map.remove} onError={map.reportError} />
            : map.loadingSelection ? <Text role="status">선택을 불러오는 중</Text> : <EditorPropertiesPanel readOnly={readOnly || isMutationPending} />)}
          {panelTab === "placement" && <EditorBatchPlacementPanel readOnly={readOnly || isMutationPending} />}
          {panelTab === "properties" && <MapPolygonControls editor={map} readOnly={readOnly || isMutationPending} onBegin={() => { if (isNarrowLayout) closePanel("information"); }} />}
          {panelTab === "layers" && <EditorLayersPanel readOnly={readOnly || isMutationPending} mapEditor={map} />}
          <div className={panelTab === "details" ? "grid gap-3" : "hidden"} aria-hidden={panelTab !== "details"}>
          <CadImportPanel
            floorId={floorId}
            expectedRevision={baseline?.floor.mapRevision ?? initialState.floor.mapRevision}
            leaseToken={leaseToken}
            leaseFence={leaseFence}
            disabled={readOnly || saveStatus === "saving" || restoringRevision !== null || map.preparing}
            isDirty={isDirty}
            resetSummary={cadResetSummary}
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
          </div>
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
