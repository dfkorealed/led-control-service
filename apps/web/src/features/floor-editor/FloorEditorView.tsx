import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { Bell, CircleCheck, PanelLeft, PanelRight, RotateCcw, TriangleAlert, Undo2, Redo2 } from "lucide-react";
import { type DragEvent, type Ref, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AuthUser } from "../../api/auth";
import { mapDocumentRefSchema } from "@led-control/shared/map-document-contracts";
import { ApiError } from "../../api/client";
import { LoadingIndicator, Button, Checkbox, ConfirmDialog, FeedbackState, Heading, IconButton, IconTooltipButton, ModalDialog, SelectBox, SidePanel, Text, UnderlineTabs, UnderlineTabPanel, panelPaddingClass, formatTimestamp, useSessionStatus, useSessionToast, type SessionStatusItem  } from "../../components/ui";
import { MapCameraControls } from "../../components/ui/maps/MapCameraControls";
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
import { MapClearDialog } from "./MapClearDialog";
import { clearFloorEditorDocument, type FloorEditorClearInput, type FloorEditorClearMode } from "../../api/floor-editor-reset";
import { MapPolygonControls } from "./MapPolygonControls";
import { synchronizeMonitoringCaches } from "./editor-monitoring-cache";
import { useFloorEditorStore } from "./editor-store";
import type { CadImportReviewState, FloorEditorState, FloorImportApplyResult } from "./editor-types";
import { snapPointToGridWithinBounds, type Point } from "./geometry";

import { registerMobileBackGuard } from "../mobile/mobile-back";

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
  onNativeBack?: () => boolean;
  floors?: Array<{ id: string; name: string }>;
  onFloorChange?: (floorId: string) => void;
  initialPanelTab?: "properties" | "details";
}

const TOOL_DRAG_DATA_TYPE = "application/x-floor-editor-tool";

export function FloorEditorView({
  initialState,
  userRole,
  readOnly = false,
  leaseToken,
  leaseFence,
  onSaved,
  onReload,
  onDirtyChange,
  onNativeBack,
  floors,
  onFloorChange,
  initialPanelTab = "properties"
}: FloorEditorViewProps) {
  readOnly ||= userRole !== "admin" || !leaseToken || !leaseFence;
  const queryClient = useQueryClient();
  const { initialState: baseline, state, isDirty, activeTool, zoom, initialize, adoptBaseline, setActiveTool, setZoom, resetZoom, past, future, snap, selection, cadSelection, selectedFixtureIds } = useFloorEditorStore(useShallow((s) => ({ initialState: s.initialState, state: s.state, isDirty: s.isDirty, activeTool: s.activeTool, zoom: s.zoom, initialize: s.initialize, adoptBaseline: s.adoptBaseline, setActiveTool: s.setActiveTool, setZoom: s.setZoom, resetZoom: s.resetZoom, past: s.past, future: s.future, snap: s.snap, selection: s.selection, cadSelection: s.cadSelection, selectedFixtureIds: s.selectedFixtureIds })));
  const [panelTab, setPanelTab] = useState<string>(initialPanelTab);
  const panelTabsId = useId();
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => window.matchMedia?.("(max-width: 1279px)").matches ?? false);
  const [openPanel, setOpenPanel] = useState<"tools" | "information" | null>(() => initialPanelTab === "details" ? "information" : null);
  const [placementDraft, setPlacementDraft] = useState<{ floorId: string; siteId: string; fixtureId: string; point: Point | null } | null>(null);
  const [isToolPanelDragging, setIsToolPanelDragging] = useState(false);
  const panelDragSource = useRef<HTMLElement | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState({ tools: false, information: false });
  const toolsToggle = useRef<HTMLButtonElement>(null);
  const informationToggle = useRef<HTMLButtonElement>(null);
  const toolsPanel = useRef<HTMLDivElement>(null);
  const informationPanel = useRef<HTMLElement>(null);
  const historyEntry = useRef<HTMLElement>(null);
  const historyIntent = useRef(initialPanelTab === "details");
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
  const nativeBack = useRef<() => boolean>(() => false);
  nativeBack.current = () => {
    // One registration owns panel → route ordering; separate LIFO guards could
    // open the dirty dialog before closing a panel after a state update.
    if (isNarrowLayout && openPanel) {
      if (!panelDragSource.current) closePanel(openPanel);
      return true;
    }
    return onNativeBack?.() ?? false;
  };
  useEffect(() => registerMobileBackGuard(() => nativeBack.current()), []);
  useEffect(() => {
    if (openPanel) (openPanel === "tools" ? toolsPanel : informationPanel).current?.focus();
  }, [openPanel]);
  useEffect(() => {
    if (!historyIntent.current || !historyEntry.current) return;
    const region = historyEntry.current;
    historyIntent.current = false;
    region.focus();
    region.scrollIntoView?.({ block: "nearest" });
  });
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
  const [clearOpen, setClearOpen] = useState(false);
  const [isClearPending, setIsClearPending] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearCommand = useRef<{ key: string; input: FloorEditorClearInput } | null>(null);
  const [importReview, setCadImportReview] = useState<CadImportReviewState | null>(null);
  const cadImportReview = importReview?.job.floorId === initialState.floor.id ? importReview : null;
  const [skippedFixtureCount, setSkippedFixtureCount] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  const rowRegistry = useMemo(createFixturePlacementRowRegistry, []);
  const mutationLock = useRef(false);
  const activeInstance = useRef(true);
  const activeScope = useRef({ floorId: initialState.floor.id, siteId: initialState.floor.siteId, authScope: draftScope, readOnly, leaseToken, leaseFence });
  activeScope.current = { floorId: initialState.floor.id, siteId: initialState.floor.siteId, authScope: draftScope, readOnly, leaseToken, leaseFence };
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
  const lease = useMemo(() => leaseToken && leaseFence ? { leaseToken, leaseFence } : undefined, [leaseToken, leaseFence]);
  const map = useMapEditor({ floorId, authScope: draftScope, readOnly, lease });
  const stageProgress = useFloorEditorStore(s => s.stageProgress);
  const fixtureLayer = useFloorEditorStore(s => s.layers.fixtures);
  const lockedFixtureIds = useFloorEditorStore(s => s.lockedFixtureIds);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const toast = useSessionToast();
  const noticeScope = `floor-editor:${draftScope}:${floorId}`;
  const notices = useMemo<SessionStatusItem[]>(() => {
    const items: SessionStatusItem[] = [];
    const add = (id: string, tone: SessionStatusItem["tone"], title: string, actionable = false) => items.push({
      id: `${noticeScope}:${id}`, fingerprint: title, source: "query", tone, title,
      ...(actionable ? { action: { label: "편집 복구 열기", onAction: () => setFeedbackOpen(true) } } : {})
    });
    if (saveStatus === "error" && !map.error) add("save", "danger", "변경분을 저장하지 못했습니다.");
    if (saveStatus === "conflict") add("conflict", "danger", "최신 맵과 변경사항이 충돌했습니다.", true);
    if (map.error) add("map", "danger", map.error, true);
    if (draftError) add("draft", "warning", "이 브라우저에 초안을 보관하지 못했습니다. 서버에 저장하세요.");
    if (recovery) add("recovery", "warning", "저장하지 않은 로컬 초안이 있습니다.", true);
    if (map.preparing || map.pendingStage || map.retryStage || stageProgress) add("stage", "info", map.preparing ? "대량 편집을 준비하고 있습니다." : map.pendingStage ? "대량 편집 준비 완료 · 저장 대기" : "대량 편집 준비가 중단되었습니다.", true);
    if (skippedFixtureCount) add("skipped", "info", `현재 존재하지 않는 조명 ${skippedFixtureCount}개를 건너뛰었습니다.`);
    return items;
  }, [noticeScope, saveStatus, map.error, draftError, recovery, map.preparing, map.pendingStage, Boolean(map.retryStage), Boolean(stageProgress), skippedFixtureCount]);
  useSessionStatus(noticeScope, notices);
  useEffect(() => { setFeedbackOpen(false); return () => { toast.dismiss(`${noticeScope}:saved`); toast.dismiss(`${noticeScope}:clear-error`); }; }, [noticeScope, toast]);

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
    const flush = () => { clearTimeout(timer); persist(); };
    const handleVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    const handleLifecycle = (event: Event) => {
      // A native picker can temporarily report inactive; only suspension flushes
      // the pending local draft. Neither path submits a server mutation.
      if ((event as CustomEvent<{ state?: unknown }>).detail?.state === "background") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("led-control:webview-lifecycle", handleLifecycle);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      flush(); unsubscribe();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("led-control:webview-lifecycle", handleLifecycle);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [userId, draftScope, baseline, floorId, siteId]);

  useEffect(() => {
    onDirtyChange?.(isDirty || isClearPending);
  }, [isDirty, isClearPending, onDirtyChange]);

  useEffect(() => {
    setPanelTab((current) => current === "details" || current === "layers" ? current : "properties");
  }, [selection?.kind, selection?.id, cadSelection?.targetId, selectedFixtureIds.length]);

  const isCurrentSave = useCallback((principalGeneration: number) => {
    return activeInstance.current && principalGeneration === editorDraftGeneration()
      && activeScope.current.floorId === floorId && activeScope.current.siteId === siteId
      && activeScope.current.authScope === draftScope
      && !activeScope.current.readOnly && activeScope.current.leaseToken === leaseToken && activeScope.current.leaseFence === leaseFence
      && useFloorEditorStore.getState().initialState?.floor.id === floorId
      && useFloorEditorStore.getState().initialState?.floor.siteId === siteId;
  }, [draftScope, floorId, siteId, leaseToken, leaseFence]);

  async function handleClear(mode: FloorEditorClearMode) {
    const current = useFloorEditorStore.getState();
    const original = current.initialState;
    const document = original?.floor.mapDocument;
    if (readOnly || mutationLock.current || map.preparing || current.pendingMapStage || !document || !original
      || original.floor.id !== floorId || original.floor.siteId !== siteId || !leaseToken || !leaseFence) return;
    const principalGeneration = editorDraftGeneration();
    const sameSession = () => isCurrentSave(principalGeneration)
      && useFloorEditorStore.getState().initialState?.floor.mapDocument?.generationId === document.generationId
      && useFloorEditorStore.getState().initialState?.floor.mapRevision === original.floor.mapRevision;
    const key = JSON.stringify([draftScope, principalGeneration, floorId, siteId, document.generationId, original.floor.mapRevision, leaseToken, leaseFence, mode]);
    // A lost POST or subsequent GET response is ambiguous. Replay exactly the
    // original command, never infer a successful clear from an empty document.
    if (clearCommand.current?.key !== key) clearCommand.current = { key, input: {
      requestId: crypto.randomUUID(), baseRevision: original.floor.mapRevision, leaseToken, leaseFence, mode
    } };
    const command = clearCommand.current;
    mutationLock.current = true;
    setIsClearPending(true); setClearError(null);
    let readStarted = false;
    try {
      const ref = await clearFloorEditorDocument(floorId, command.input);
      if (!sameSession()) return;
      readStarted = true;
      const next = await getFloorEditorState(floorId);
      if (!sameSession()) return;
      if (next.floor.id !== floorId || next.floor.siteId !== siteId || next.floor.mapRevision !== ref.revision
        || JSON.stringify(mapDocumentRefSchema.parse(next.floor.mapDocument)) !== JSON.stringify(mapDocumentRefSchema.parse(ref))) throw new Error("Map clear response scope/ref mismatch");
      removeEditorDraft(draftScope, original);
      initialize(next, draftScope);
      toast.dismiss(`${noticeScope}:clear-error`);
      clearCommand.current = null;
      setRecovery(null); setDraftError(false); setClearOpen(false); setSaveStatus("idle");
      const currentAcknowledgement = () => isCurrentSave(principalGeneration)
        && useFloorEditorStore.getState().initialState?.floor.mapDocument?.generationId === ref.generationId
        && useFloorEditorStore.getState().initialState?.floor.mapRevision === ref.revision;
      await invalidateEditorQueries(queryClient, next);
      if (!currentAcknowledgement()) return;
      await onSaved(next);
      if (currentAcknowledgement()) toast.publish({ id: `${noticeScope}:saved`, tone: "success", title: "맵을 초기화했습니다." });
    } catch (error) {
      // Always inspect server state after a failed POST too, but require its
      // idempotent receipt before adopting it or discarding any local edits.
      if (!readStarted && sameSession()) await getFloorEditorState(floorId).catch(() => undefined);
      if (sameSession()) {
        const message = "맵 초기화 결과를 확인하지 못했습니다. 다시 시도하거나 최신 맵을 불러오세요.";
        setClearError(message);
        toast.publish({ id: `${noticeScope}:clear-error`, tone: "danger", title: message });
        if (error instanceof ApiError && error.status === 409) setSaveStatus("conflict");
      }
    } finally {
      mutationLock.current = false;
      if (activeInstance.current) setIsClearPending(false);
    }
  }

  useEffect(() => { setClearOpen(false); setClearError(null); clearCommand.current = null; }, [floorId, siteId, draftScope]);

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
    toast.publish({ id: `${noticeScope}:saved`, tone: "success", title: "맵을 저장했습니다." });
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
    const principalGeneration = editorDraftGeneration();
    const authoritative = await getFloorEditorState(floorId);
    // A late authoritative read must not revive a purged or departed editor scope.
    if (!isCurrentSave(principalGeneration)) return;
    if (authoritative.floor.id !== floorId || authoritative.floor.siteId !== siteId) {
      throw new Error("Editor response scope mismatch");
    }
    if (userId && baseline) removeEditorDraft(draftScope, baseline);
    // A legacy map has no mapScope to inherit. Bind the incoming common map to
    // this principal so the later query echo does not initialize away its fit.
    if (authoritative.floor.mapDocument) initialize(authoritative, draftScope);
    else adoptBaseline(authoritative);
    await invalidateEditorQueries(queryClient, authoritative);
    if (!isCurrentSave(principalGeneration)) return;
    await onSaved(authoritative);
    if (isCurrentSave(principalGeneration)) {
      setSaveStatus("idle");
      toast.publish({ id: `${noticeScope}:saved`, tone: "success", title: "CAD 도면을 적용하고 저장했습니다." });
    }
  }, [adoptBaseline, initialize, baseline, draftScope, floorId, isCurrentSave, noticeScope, onSaved, queryClient, siteId, toast, userId]);

  const revisions = revisionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const appliedOverlay = appliedOverlayQuery.data?.overlay;
  const currentAppliedOverlay = appliedOverlay && state
    && appliedOverlay.floorId === floorId
    && appliedOverlay.revision === state.floor.mapRevision
    && appliedOverlay.renderedAssetPath === state.floor.floorPlan?.imageUrl
    ? appliedOverlay
    : null;
  // Prepared imports belong exclusively to the modal. The editor retains its
  // committed document/camera and never adopts preview geometry before apply.
  const visibleCadCandidates = currentAppliedOverlay?.candidates ?? [];
  const visibleCadViewport = currentAppliedOverlay?.renderedViewport;
  const visibleCadBackgroundUrl = currentAppliedOverlay?.renderedAssetPath;
  const acceptedCadCandidateIds = useMemo(() => new Set(
    currentAppliedOverlay?.candidates.map(candidate => candidate.id) ?? []
  ), [currentAppliedOverlay?.candidates]);
  const cadResetSummary = useMemo(() => ({
    fixtureCount: state?.floor.id === floorId ? state.fixtures.length : initialState.fixtures.length,
    objectCount: state?.floor.id === floorId ? state.objects.length : initialState.objects.length,
    slotCount: state?.floor.id === floorId ? state.lightSlots.length : initialState.lightSlots.length
  }), [floorId, initialState.fixtures.length, initialState.lightSlots.length, initialState.objects.length, state]);
  const isMutationPending = saveStatus === "saving" || restoringRevision !== null || isCadImportPending || isResetPending || isClearPending || map.preparing;
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
            <Heading as="h1" variant="customer-page-title" className="truncate">{initialState.floor.name} 맵 편집</Heading>
            <Text variant="caption" tone="secondary">리비전 {baseline?.floor.mapRevision ?? initialState.floor.mapRevision}{isDirty ? " · 저장하지 않은 변경사항" : " · 저장됨"}</Text>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <CadImportPanel floorId={floorId}
              expectedRevision={baseline?.floor.mapRevision ?? initialState.floor.mapRevision}
              leaseToken={leaseToken} leaseFence={leaseFence}
              disabled={readOnly || saveStatus === "saving" || restoringRevision !== null || isResetPending || isClearPending || map.preparing}
              isDirty={isDirty} resetSummary={cadResetSummary} review={cadImportReview}
              onReviewChange={setCadImportReview} onBusyChange={handleCadBusyChange}
              onApplied={handleCadApplied} onConflict={() => setSaveStatus("conflict")} />
            {floors && onFloorChange && <SelectBox label="층 선택" className="w-32 min-w-0 [&>label]:sr-only" items={floors.map((floor) => ({ id: floor.id, label: floor.name }))} selectedKey={floorId} isDisabled={isMutationPending} onSelectionChange={(key) => { if (key && !mutationLock.current) onFloorChange(key); }} />}
            <Button size="sm" variant="primary" className="min-h-13 min-w-13 text-action-primary-foreground" disabled={!isDirty || isSaveOrRestoreBlocked} isLoading={saveStatus === "saving"} loadingLabel="저장 중" onClick={handleSave}>{isDirty ? "저장" : "저장됨"}</Button>
            <Button size="sm" variant="secondary" className="min-h-13" disabled={isSaveOrRestoreBlocked || !map.document || Boolean(map.pendingStage || map.retryStage)}
              title={!map.document ? "이전 형식 맵은 공통 맵 전환 후 초기화할 수 있습니다." : undefined}
              onClick={() => { if (!mutationLock.current) { setClearError(null); setClearOpen(true); } }}><RotateCcw size={16} aria-hidden="true" />맵 초기화</Button>
          </div>
        </div>
        <div className="flex flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-border-default py-1" role="toolbar" aria-label="맵 보기 도구">
          <IconTooltipButton size="sm" ref={toolsToggle} icon={PanelLeft} label="도구 및 조명 패널" aria-expanded={toolsVisible} aria-controls="editor-tools-panel" onClick={() => togglePanel("tools")} />
          <IconTooltipButton size="sm" icon={Undo2} label="실행 취소" disabled={isSaveOrRestoreBlocked || !past.length} onClick={() => void map.history("undo")} />
          <IconTooltipButton size="sm" icon={Redo2} label="다시 실행" disabled={isSaveOrRestoreBlocked || !future.length} onClick={() => void map.history("redo")} />
          <MapCameraControls className="shrink-0 flex-nowrap" zoomPercent={Math.round(zoom * 100)} onZoomOut={() => setZoom(zoom / 1.1)} onZoomIn={() => setZoom(zoom * 1.1)}
            onResetZoom={resetZoom} onFit={() => useFloorEditorStore.getState().fit(false, visibleCadViewport ?? undefined)}
            onFitSelection={() => map.document ? map.fitSelection() : useFloorEditorStore.getState().fit(true)}
            canZoomOut={zoom > 0.001} canZoomIn={zoom < 4} fitLabel="맵 맞춤" />
          <IconTooltipButton size="sm" ref={informationToggle} icon={PanelRight} label="편집 정보 패널" aria-expanded={informationVisible} aria-controls="editor-information-panel" onClick={() => togglePanel("information")} />
          <IconTooltipButton size="sm" icon={Bell} label="편집 복구" disabled={!notices.some(item => item.action)} onClick={() => setFeedbackOpen(true)} />
        </div>
      </header>

      {clearOpen && <MapClearDialog floorName={initialState.floor.name} isPending={isClearPending}
        disabled={readOnly || (!isClearPending && isMutationPending) || !map.document || Boolean(map.pendingStage || map.retryStage)}
        error={clearError} onCancel={() => { if (!mutationLock.current) setClearOpen(false); }} onConfirm={mode => void handleClear(mode)} />}

      {!map.document && !cadImportReview && <MapDocumentInitialization state={initialState} readOnly={readOnly || isDirty || saveStatus === "saving" || restoringRevision !== null || isCadImportPending} leaseToken={leaseToken} leaseFence={leaseFence} onBusyChange={handleResetBusyChange}
        onInitialized={next => { initialize(next, draftScope); void invalidateEditorQueries(queryClient, next); void onSaved(next); }} />}
      <ModalDialog isOpen={feedbackOpen} title="편집 복구" onClose={() => setFeedbackOpen(false)}>
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
            setFeedbackOpen(false);
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
          setFeedbackOpen(false);
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
      {map.error && <FeedbackState tone="danger" icon={TriangleAlert} title={map.error} action={<Button onClick={() => { setFeedbackOpen(false); if (isDirty) setConfirmReload(true); else void onReload(); }}>다시 불러오기</Button>} />}
      </ModalDialog>

      {/* Canvas errors must stay actionable above an open narrow panel. Bound
          that notice to 80px and reserve 96px including its existing top inset. */}
      {/* A short screen scrolls the shell chrome instead of collapsing the
          canvas and information tabs to zero. Size containment keeps long tab
          contents from changing that minimum or resizing the map on tab change. */}
      <div className="relative flex min-h-64 min-w-0 flex-1 gap-3 overflow-hidden [contain:size]" data-testid="floor-editor-layout" onDrop={finishPanelDrag}>
        {/* Keep panels mounted while collapsed: import jobs, form drafts and the
            fixture drag registry must outlive a layout-only visibility change. */}
        {/* Opacity/pointer-events expose the drop surface without removing or
            hiding the native drag source. dragend also restores cancelled drags;
            the workbench drop handler covers a placed source leaving its list. */}
        <div ref={toolsPanel} id="editor-tools-panel" tabIndex={-1} aria-label="도구 및 조명"
          onDragStart={beginPanelDrag} onDragEnd={finishPanelDrag}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (!panelDragSource.current) closePanel("tools"); } }}
          className={`${toolsVisible ? "flex" : "hidden"} ${isNarrowLayout ? "absolute inset-y-0 left-0 z-10 w-[min(280px,100%)] shadow-panel" : "w-[220px] shrink-0"} ${isToolPanelDragging ? "pointer-events-none opacity-0" : ""} min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain border-r border-border-default bg-surface-panel [&>aside]:flex-none [&>aside:first-child]:h-112`}><FixturePlacementList readOnly={readOnly || isMutationPending || (isNarrowLayout && !map.document)} rowRegistry={rowRegistry} onPlacementRequest={isNarrowLayout ? (fixtureId) => {
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
            acceptedCadCandidateIds={acceptedCadCandidateIds}
            mapEditor={map}
            placementDraftPoint={placementFixture ? placementDraft?.point : null}
            onPlacementPointChange={placementFixture ? (point) => updatePlacementPoint(placementFixture.id, point) : undefined}
          />
          {placementFixture ? <MobileFixturePlacementBar key={placementFixture.id} fixtureName={placementFixture.name} point={placementDraft?.point ?? null} bounds={placementBounds}
            onPointChange={(point) => updatePlacementPoint(placementFixture.id, point)}
            onCancel={() => { setPlacementDraft(null); setOpenPanel("tools"); requestAnimationFrame(() => rowRegistry.focus(placementFixture.id)); }}
            onConfirm={confirmPlacement} /> : null}
        </main>
        <SidePanel ref={informationPanel} id="editor-information-panel" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePanel("information"); } }} className={`${informationVisible ? "flex" : "hidden"} ${isNarrowLayout ? "absolute inset-y-0 right-0 z-10 w-[min(320px,100%)] shadow-panel" : "w-[280px] shrink-0"} min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-none border-0 border-l border-border-default p-0`} aria-label="맵 편집 정보">
          <UnderlineTabs id={panelTabsId} label="편집 패널" value={panelTab} onChange={setPanelTab}
            items={[{ value: "properties", label: "속성" }, { value: "placement", label: "배치" }, { value: "layers", label: "레이어" }, { value: "details", label: "기록" }]} />
          <UnderlineTabPanel tabsId={panelTabsId} value="properties" activeValue={panelTab} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {panelTab === "properties" && (map.shapeCount && (map.selectionCount > 1 || !map.selection.length)
            ? <MapSelectionProperties key={JSON.stringify([map.selectionKey, map.bounds])} editor={map} readOnly={readOnly || isMutationPending} />
            : map.selection.length
            ? <MapElementPropertiesPanel selection={map.selection} gridSize={snap ? map.mapBounds?.gridSize : undefined} mapBounds={map.mapBounds ?? undefined} readOnly={readOnly || isMutationPending} locked={map.locked} onChange={map.commit} onDelete={map.requestRemove} onError={map.reportError} />
            : map.loadingSelection ? <LoadingIndicator>선택을 불러오는 중</LoadingIndicator> : <EditorPropertiesPanel readOnly={readOnly || isMutationPending} mapEditor={map} />)}
          {panelTab === "properties" && <MapPolygonControls editor={map} readOnly={readOnly || isMutationPending} onBegin={() => { if (isNarrowLayout) closePanel("information"); }} />}
          </UnderlineTabPanel>
          <UnderlineTabPanel tabsId={panelTabsId} value="placement" activeValue={panelTab} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {panelTab === "placement" && <EditorBatchPlacementPanel readOnly={readOnly || isMutationPending} />}
          </UnderlineTabPanel>
          <UnderlineTabPanel tabsId={panelTabsId} value="layers" activeValue={panelTab} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {panelTab === "layers" && <EditorLayersPanel readOnly={readOnly || isMutationPending} mapEditor={map} />}
          </UnderlineTabPanel>
          {/* One reader owns both identify and history overflow. Neither child
              may consume the other's scroll area when a fixture is selected. */}
          <UnderlineTabPanel tabsId={panelTabsId} value="details" activeValue={panelTab} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain [&>section]:shrink-0">
          <FixtureIdentifyPanel floorId={floorId} readOnly={readOnly || isMutationPending} leaseToken={leaseToken} leaseFence={leaseFence} />
          <RevisionPanel
            historyEntryRef={historyEntry}
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
          </UnderlineTabPanel>
        </SidePanel>
      </div>
      {map.removeRequested && <ConfirmDialog open title="선택 전체 삭제" destructive confirmLabel="전체 삭제"
        confirmDisabled={readOnly || isMutationPending || map.locked || map.loadingSelection} onCancel={map.cancelRemove} onConfirm={() => void map.confirmRemove()}>
        <Text>{map.shapeCount}개 도형을 삭제하고 {map.fixtureCount}개 조명의 배치를 제거합니다. 조명 장비는 삭제되지 않습니다.</Text>
      </ConfirmDialog>}
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
  historyEntryRef,
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
  historyEntryRef?: Ref<HTMLElement>;
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
    <section ref={historyEntryRef} tabIndex={-1} className={`flex flex-none flex-col gap-3 border-t border-border-subtle ${panelPaddingClass("regular")}`} aria-label="맵 버전">
      <div className="grid shrink-0 gap-1">
        <Text variant="overline" tone="secondary">버전</Text>
        <Heading as="h3" variant="customer-card-title">변경 기록</Heading>
      </div>
      {isLoading ? <LoadingIndicator>버전 기록을 불러오는 중</LoadingIndicator> : null}
      {isError ? (
        <div className="grid gap-2" role="alert">
          <Text variant="body-sm" tone="danger">버전 기록을 불러오지 못했습니다.</Text>
          <Button variant="secondary" onClick={onRetry}>다시 시도</Button>
        </div>
      ) : null}
      {!isLoading && !isError && revisions.length === 0 ? <Text variant="body-sm" tone="secondary">저장된 버전이 없습니다.</Text> : null}
      {!isLoading && !isError && revisions.length > 0 ? (
        <ol className="m-0 grid flex-none list-none content-start gap-0 p-0" data-testid="editor-revision-list">
          {revisions.map((revision) => (
            <li className="flex items-center justify-between gap-2.5 border-t border-border-default py-2.5 first:border-t-0 first:pt-0" key={revision.revision}>
              <div className="grid min-w-0 gap-0.5">
                <Text as="strong" variant="body-sm" weight="semibold">리비전 {revision.revision}</Text>
                <Text as="span" variant="caption" tone="secondary">{revision.actor.displayName}</Text>
                <Text as="time" variant="caption" tone="secondary" dateTime={revision.createdAt}>{formatTimestamp(revision.createdAt)}</Text>
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
        <Button variant="secondary" disabled={isFetchingNextPage} isLoading={isFetchingNextPage} loadingLabel="불러오는 중" onClick={onLoadMore}>
          이전 버전 더 보기
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
