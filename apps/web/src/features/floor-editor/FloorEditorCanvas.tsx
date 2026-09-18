import Konva from "konva";
import type { FloorImportCandidate, FloorImportRenderedViewport } from "@led-control/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Circle, Image as KonvaImage, Label, Layer, Line, Rect, Shape, Stage, Tag, Text, Transformer } from "react-konva";
import { Button, themeColor } from "../../components/ui";
import { FloorMapObjectNode, trianglePoints } from "../floor-map/FloorScene";
import {
  alignRectToGuides,
  clampObjectToMap,
  clampPoint,
  createDefaultObject,
  createObjectFromDrag,
  screenToWorld,
  type AlignmentGuide,
  type MapRect,
  type Point
} from "./geometry";
import { useFloorEditorStore } from "./editor-store";
import type { EditorFixture, EditorTool, FloorEditorState, FloorMapObject, FloorMapObjectDraft } from "./editor-types";
import { EditorFixtureNode, type EditorFixturePalette } from "./EditorFixtureNode";
import { FIXTURE_DRAG_TYPE, type FixturePlacementRowRegistry } from "./FixturePlacementList";
import { FixturePlacementAction } from "./FixturePlacementAction";
import { EditorMinimap } from "./EditorMinimap";
import { canShowFixtureNames, selectedFixtureLabelLayout } from "./editor-labels";
import { CadCandidateLayer } from "./CadCandidateLayer";
import {
  buildAvailableCadSlotIndex,
  CAD_SLOT_HIT_RADIUS,
  CadPlacementSlotLayer,
  findAvailableCadSlotAtPoint
} from "./CadPlacementSlotLayer";
import { useFloorPlanImage } from "./use-floor-plan-image";
import { buildEditorSpatialIndex, mapObjectWorldAabb, queryEditorSpatialIndex } from "./editor-spatial-index";

const TOOL_DRAG_TYPE = "application/x-floor-editor-tool";
const drawingTools = new Set<EditorTool>(["rectangle", "triangle", "line", "text"]);
type Gesture = { kind: "pan" | "marquee" | "draw"; start: Point; screen: Point; pan: Point; additive: boolean; moved: boolean };
type DragInteraction = { token: number; kind: "fixture" | "object"; id: string; floorId: string };

interface FloorEditorCanvasProps {
  readOnly?: boolean;
  rowRegistry: FixturePlacementRowRegistry;
  cadCandidates?: FloorImportCandidate[];
  cadBackgroundUrl?: string | null;
  cadViewport?: FloorImportRenderedViewport | null;
  acceptedCadCandidateIds?: Set<string>;
  focusedCadCandidateId?: string | null;
  onFocusedCadCandidateChange?: (candidateId: string | null) => void;
  onToggleCadCandidate?: (candidateId: string) => void;
}

export function FloorEditorCanvas({
  readOnly = false,
  rowRegistry,
  cadCandidates = [],
  cadBackgroundUrl,
  cadViewport,
  acceptedCadCandidateIds = new Set(),
  focusedCadCandidateId,
  onFocusedCadCandidateChange,
  onToggleCadCandidate
}: FloorEditorCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<Konva.Stage>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const nodes = useRef(new Map<string, Konva.Node>());
  const objectNodes = useRef(new Map<string, Konva.Node>());
  const objectRefCallbacks = useRef(new Map<string, (node: Konva.Node | null) => void>());
  const gesture = useRef<Gesture | null>(null);
  const groupDrag = useRef<Array<{ id: string; x: number; y: number }>>([]);
  const guideTargets = useRef<MapRect[]>([]);
  const verticalGuide = useRef<Konva.Line>(null);
  const horizontalGuide = useRef<Konva.Line>(null);
  const pointerFrame = useRef<number | null>(null);
  const pendingPointerMove = useRef<(() => void) | null>(null);
  const dragFrame = useRef<number | null>(null);
  const pendingDragMove = useRef<(() => void) | null>(null);
  const dragToken = useRef(0);
  const dragInteraction = useRef<DragInteraction | null>(null);
  const creationDraft = useRef<FloorMapObjectDraft | null>(null);
  const marqueeDraft = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const lastAutoFitKey = useRef<string | null>(null);
  const disabled = useRef(readOnly); disabled.current = readOnly;
  const state = useFloorEditorStore((s) => s.state);
  const activeTool = useFloorEditorStore((s) => s.activeTool);
  const zoom = useFloorEditorStore((s) => s.zoom);
  const pan = useFloorEditorStore((s) => s.pan);
  const viewport = useFloorEditorStore((s) => s.viewport);
  const selection = useFloorEditorStore((s) => s.selection);
  const selectedIds = useFloorEditorStore((s) => s.selectedFixtureIds);
  const layers = useFloorEditorStore((s) => s.layers);
  const lockedIds = useFloorEditorStore((s) => s.lockedFixtureIds);
  const preview = useFloorEditorStore((s) => s.preview);
  const snap = useFloorEditorStore((s) => s.snap);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const lockedSet = useMemo(() => new Set(lockedIds), [lockedIds]);
  const placedFixtureCollection = useMemo(() => {
    const items = state?.fixtures.filter((fixture) => fixture.placementStatus !== "unplaced") ?? [];
    const byId = new Map(items.map((fixture) => [fixture.id, fixture]));
    const orderById = new Map(items.map((fixture, order) => [fixture.id, order]));
    const spatialIndex = buildEditorSpatialIndex(items.map((fixture) => {
      const size = fixture.size ?? 20;
      return { id: fixture.id, x: fixture.x - size / 2, y: fixture.y - size / 2, width: size, height: size };
    }), 128);
    return { items, byId, orderById, spatialIndex };
  }, [state?.fixtures]);
  const objectCollection = useMemo(() => {
    const items = (state?.objects.filter((object) => object.visible) ?? []).sort((a, b) => a.zIndex - b.zIndex);
    const byId = new Map(items.map((object) => [object.id, object]));
    const spatialIndex = buildEditorSpatialIndex(items.map((object) => ({ id: object.id, ...mapObjectWorldAabb(object) })), 128);
    return { byId, spatialIndex };
  }, [state?.objects]);
  const availableSlotIndex = useMemo(() => buildAvailableCadSlotIndex(state?.lightSlots ?? []), [state?.lightSlots]);
  const placedFixtures = placedFixtureCollection.items;
  const [creation, setCreation] = useState<FloorMapObjectDraft | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [dropPreview, setDropPreview] = useState<Point | null>(null);
  const [highlightedSlotId, setHighlightedSlotId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [transientPan, setTransientPan] = useState<Point | null>(null);
  const floorPlan = state?.floor.floorPlan;
  const backgroundUrl = cadBackgroundUrl
    ?? (floorPlan?.sourceType !== "none" ? floorPlan?.renderedImageUrl ?? floorPlan?.imageUrl : "");
  const { image: background, status: backgroundStatus, retry: retryBackground } = useFloorPlanImage(backgroundUrl ?? "");
  const bounds = cadBackgroundUrl && cadViewport
    ? cadViewport
    : { width: floorPlan?.width ?? 1200, height: floorPlan?.height ?? 800 };
  const renderedPan = transientPan ?? pan;
  const viewportBounds = {
    x: -renderedPan.x / zoom,
    y: -renderedPan.y / zoom,
    width: viewport.width / zoom,
    height: viewport.height / zoom
  };
  const visibleFixtures = useMemo(() => {
    const visibleIds = new Set(queryEditorSpatialIndex(placedFixtureCollection.spatialIndex, viewportBounds, 160 / zoom).map((item) => item.id));
    selectedIds.forEach((id) => {
      if (placedFixtureCollection.byId.has(id)) visibleIds.add(id);
    });
    return [...visibleIds]
      .map((id) => placedFixtureCollection.byId.get(id))
      .filter((fixture): fixture is EditorFixture => fixture !== undefined)
      .sort((a, b) => placedFixtureCollection.orderById.get(a.id)! - placedFixtureCollection.orderById.get(b.id)!);
  }, [placedFixtureCollection, selectedIds, viewportBounds.height, viewportBounds.width, viewportBounds.x, viewportBounds.y, zoom]);
  const visibleObjects = useMemo(() => {
    const visibleIds = new Set(queryEditorSpatialIndex(objectCollection.spatialIndex, viewportBounds, 160 / zoom).map((item) => item.id));
    if (selection?.kind === "object" && objectCollection.byId.has(selection.id)) visibleIds.add(selection.id);
    return [...visibleIds]
      .map((id) => objectCollection.byId.get(id))
      .filter((object): object is FloorMapObject => object !== undefined)
      .sort((a, b) => a.zIndex - b.zIndex);
  }, [objectCollection, selection, viewportBounds.height, viewportBounds.width, viewportBounds.x, viewportBounds.y, zoom]);
  const showBulkNames = useMemo(() => canShowFixtureNames(visibleFixtures, zoom), [visibleFixtures, zoom]);

  useEffect(() => {
    if (!cadBackgroundUrl || !cadViewport) {
      lastAutoFitKey.current = null;
      return;
    }
    const key = `${cadBackgroundUrl}:${cadViewport.width}x${cadViewport.height}`;
    if (lastAutoFitKey.current === key) return;
    lastAutoFitKey.current = key;
    useFloorEditorStore.getState().fit(false, cadViewport);
  }, [cadBackgroundUrl, cadViewport?.height, cadViewport?.width]);
  const editorColors = useMemo(() => ({
    panel: themeColor("surface-panel"),
    border: themeColor("fixture-editor-border"),
    guide: themeColor("fixture-editor-guide"),
    marquee: themeColor("fixture-editor-marquee"),
    selected: themeColor("fixture-editor-selected"),
    preview: themeColor("fixture-editor-preview"),
    fixtureFill: themeColor("fixture-editor-fill"),
    label: themeColor("fixture-editor-label"),
    grid: themeColor("border-strong")
  }), []);
  const fixtureColors = useMemo<EditorFixturePalette>(() => ({
    status: {
      online: themeColor("fixture-editor-connected"),
      offline: themeColor("fixture-editor-offline"),
      fault: themeColor("fixture-editor-fault")
    },
    selected: themeColor("fixture-editor-selected"),
    border: themeColor("content-inverse"),
    label: themeColor("fixture-editor-label")
  }), []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => { const rect = element.getBoundingClientRect(); if (rect.width && rect.height) useFloorEditorStore.getState().setViewport({ width: rect.width, height: rect.height }); };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, [state?.floor.id]);

  const schedulePointerMove = useCallback((update: () => void) => {
    pendingPointerMove.current = update;
    if (pointerFrame.current !== null) return;
    pointerFrame.current = window.requestAnimationFrame(() => {
      pointerFrame.current = null;
      const pending = pendingPointerMove.current;
      pendingPointerMove.current = null;
      pending?.();
    });
  }, []);
  const flushPointerMove = useCallback(() => {
    if (pointerFrame.current !== null) window.cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = null;
    const pending = pendingPointerMove.current;
    pendingPointerMove.current = null;
    pending?.();
  }, []);
  const cancelPointerMove = useCallback(() => {
    if (pointerFrame.current !== null) window.cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = null;
    pendingPointerMove.current = null;
  }, []);
  const scheduleDragMove = useCallback((update: () => void) => {
    pendingDragMove.current = update;
    if (dragFrame.current !== null) return;
    dragFrame.current = window.requestAnimationFrame(() => {
      dragFrame.current = null;
      const pending = pendingDragMove.current;
      pendingDragMove.current = null;
      pending?.();
    });
  }, []);
  const flushDragMove = useCallback(() => {
    if (dragFrame.current !== null) window.cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    const pending = pendingDragMove.current;
    pendingDragMove.current = null;
    pending?.();
  }, []);
  const cancelDragMove = useCallback(() => {
    if (dragFrame.current !== null) window.cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    pendingDragMove.current = null;
  }, []);
  useEffect(() => () => {
    cancelPointerMove();
    cancelDragMove();
  }, [cancelDragMove, cancelPointerMove]);

  const register = useCallback((id: string, node: Konva.Node | null) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); }, []);
  const onSelect = useCallback((id: string, additive: boolean) => useFloorEditorStore.getState().selectFixture(id, additive), []);
  const renderAlignmentGuides = useCallback((guides: AlignmentGuide[]) => {
    const store = useFloorEditorStore.getState();
    const width = store.state?.floor.floorPlan?.width ?? 1200;
    const height = store.state?.floor.floorPlan?.height ?? 800;
    const vertical = guides.find((guide) => guide.orientation === "vertical");
    const horizontal = guides.find((guide) => guide.orientation === "horizontal");
    verticalGuide.current?.setAttrs({ visible: Boolean(vertical), points: vertical ? [vertical.position, 0, vertical.position, height] : [] });
    horizontalGuide.current?.setAttrs({ visible: Boolean(horizontal), points: horizontal ? [0, horizontal.position, width, horizontal.position] : [] });
    container.current?.setAttribute("data-active-guides", guides.map((guide) => guide.orientation).join(","));
    verticalGuide.current?.getLayer()?.batchDraw();
  }, []);
  const clearAlignmentGuides = useCallback(() => renderAlignmentGuides([]), [renderAlignmentGuides]);
  const restoreDraggedNodes = useCallback(() => {
    const current = useFloorEditorStore.getState().state;
    current?.fixtures.forEach((fixture) => nodes.current.get(fixture.id)?.position(fixture));
    current?.objects.forEach((object) => objectNodes.current.get(object.id)?.position(object));
  }, []);
  const cancelDragInteraction = useCallback(() => {
    dragToken.current += 1;
    dragInteraction.current = null;
    cancelDragMove();
    groupDrag.current = [];
    guideTargets.current = [];
    clearAlignmentGuides();
    restoreDraggedNodes();
  }, [cancelDragMove, clearAlignmentGuides, restoreDraggedNodes]);
  const beginDragInteraction = useCallback((kind: "fixture" | "object", id: string) => {
    const store = useFloorEditorStore.getState();
    if (disabled.current || store.activeTool !== "select" || !store.state) return null;
    if (kind === "fixture" && (!store.layers.fixtures.visible || store.layers.fixtures.locked || store.lockedFixtureIds.includes(id))) return null;
    const object = kind === "object" ? store.state.objects.find((candidate) => candidate.id === id) : null;
    if (kind === "object" && (!store.layers.objects.visible || store.layers.objects.locked || object?.locked !== false)) return null;
    const interaction = { token: ++dragToken.current, kind, id, floorId: store.state.floor.id } as const;
    dragInteraction.current = interaction;
    return interaction.token;
  }, []);
  const isDragInteractionCurrent = useCallback((token: number | null, kind: "fixture" | "object", id: string) => {
    const interaction = dragInteraction.current;
    const store = useFloorEditorStore.getState();
    if (!interaction || token === null || interaction.token !== token || interaction.kind !== kind || interaction.id !== id
      || disabled.current || store.activeTool !== "select" || store.state?.floor.id !== interaction.floorId) return false;
    if (kind === "fixture") return store.layers.fixtures.visible && !store.layers.fixtures.locked && !store.lockedFixtureIds.includes(id);
    const object = store.state.objects.find((candidate) => candidate.id === id);
    return store.layers.objects.visible && !store.layers.objects.locked && object?.locked === false;
  }, []);
  useEffect(() => {
    cancelDragInteraction();
  }, [activeTool, cancelDragInteraction, layers.fixtures.locked, layers.fixtures.visible, layers.objects.locked, layers.objects.visible, readOnly, state]);
  const onDragStart = useCallback((id: string) => {
    const store = useFloorEditorStore.getState();
    if (beginDragInteraction("fixture", id) === null) return;
    if (!store.selectedFixtureIds.includes(id)) store.selectFixture(id);
    const ids = new Set(useFloorEditorStore.getState().selectedFixtureIds);
    groupDrag.current = store.state?.fixtures.filter((f) => ids.has(f.id) && !store.lockedFixtureIds.includes(f.id) && f.placementStatus !== "unplaced") ?? [];
    guideTargets.current = collectGuideTargets(store.state, ids);
  }, [beginDragInteraction]);
  const applyFixtureDragMove = useCallback((id: string, node: Konva.Node) => {
    if (disabled.current) return;
    const store = useFloorEditorStore.getState();
    const selected = groupDrag.current;
    const origin = selected.find((f) => f.id === id);
    if (!origin || !selected.length) return;
    let dx = node.x() - origin.x, dy = node.y() - origin.y;
    dx = Math.max(-Math.min(...selected.map((f) => f.x)), Math.min(dx, (store.state?.floor.floorPlan?.width ?? 1200) - Math.max(...selected.map((f) => f.x))));
    dy = Math.max(-Math.min(...selected.map((f) => f.y)), Math.min(dy, (store.state?.floor.floorPlan?.height ?? 800) - Math.max(...selected.map((f) => f.y))));
    const moving = fixtureGroupRect(selected, { x: dx, y: dy });
    const aligned = alignRectToGuides(moving, guideTargets.current, {
      width: store.state?.floor.floorPlan?.width ?? 1200,
      height: store.state?.floor.floorPlan?.height ?? 800
    }, 6 / store.zoom);
    dx += aligned.point.x - moving.x;
    dy += aligned.point.y - moving.y;
    selected.forEach((f) => nodes.current.get(f.id)?.position({ x: f.x + dx, y: f.y + dy }));
    renderAlignmentGuides(aligned.guides);
  }, [renderAlignmentGuides]);
  const onDragMove = useCallback((id: string, node: Konva.Node) => {
    const token = dragInteraction.current?.token ?? null;
    scheduleDragMove(() => {
      if (isDragInteractionCurrent(token, "fixture", id)) applyFixtureDragMove(id, node);
    });
  }, [applyFixtureDragMove, isDragInteractionCurrent, scheduleDragMove]);
  const onDragEnd = useCallback((id: string, node: Konva.Node) => {
    const token = dragInteraction.current?.token ?? null;
    flushDragMove();
    const origin = groupDrag.current.find((f) => f.id === id);
    if (origin && isDragInteractionCurrent(token, "fixture", id)) {
      useFloorEditorStore.getState().moveFixtures(groupDrag.current.map((f) => f.id), { x: node.x() - origin.x, y: node.y() - origin.y });
    }
    cancelDragInteraction();
  }, [cancelDragInteraction, flushDragMove, isDragInteractionCurrent]);
  const onTransform = useCallback((id: string, node: Konva.Node) => {
    const fixture = useFloorEditorStore.getState().state?.fixtures.find((f) => f.id === id);
    const scale = Math.max(node.scaleX(), node.scaleY()); node.scale({ x: 1, y: 1 });
    if (fixture && !disabled.current) useFloorEditorStore.getState().updateFixture(id, { x: node.x(), y: node.y(), size: Math.min(200, Math.max(4, (fixture.size ?? 20) * scale)) });
  }, []);

  useEffect(() => {
    const selectedNode = selection?.kind === "fixture" && layers.fixtures.visible && !layers.fixtures.locked && !lockedSet.has(selection.id)
      ? nodes.current.get(selection.id)
      : selection?.kind === "object" && layers.objects.visible && !layers.objects.locked && !state?.objects.find((o) => o.id === selection.id)?.locked
        ? objectNodes.current.get(selection.id) : undefined;
    transformer.current?.nodes(!readOnly && selectedNode ? [selectedNode] : []);
    transformer.current?.getLayer()?.batchDraw();
  }, [selection, state, readOnly, layers, lockedSet]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      const store = useFloorEditorStore.getState();
      if (event.key === "Escape") {
        cancelPointerMove();
        // Imperative pan is not yet in Zustand. Restore every layer before dropping
        // the gesture, so the next drop uses exactly the transform shown on screen.
        if (gesture.current?.kind === "pan") stage.current?.getLayers().forEach((layer) => layer.position(store.pan));
        gesture.current = null; setTransientPan(null); setCreation(null); setMarquee(null); setDropPreview(null); setHighlightedSlotId(null); setIsPanning(false); store.setPreview([]); return;
      }
      if (readOnly) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? store.redo() : store.undo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); store.redo(); return; }
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (delta) {
        event.preventDefault();
        const step = store.snap ? store.state?.floor.floorPlan?.gridSize ?? 10 : event.shiftKey ? 10 : 1;
        store.moveFixtures(store.selectedFixtureIds, { x: delta[0] * step, y: delta[1] * step });
      }
      if ((event.key === "Delete" || event.key === "Backspace") && store.selection?.kind === "object") { event.preventDefault(); store.removeObject(store.selection.id); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [cancelPointerMove, readOnly]);

  if (!state) return null;
  const screenPoint = (event: { clientX: number; clientY: number }) => { const rect = container.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const worldPoint = (event: { clientX: number; clientY: number }) => screenToWorld(screenPoint(event), useFloorEditorStore.getState().pan, useFloorEditorStore.getState().zoom);

  function begin(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("button")) return;
    if (activeTool === "pan") {
      gesture.current = { kind: "pan", screen: screenPoint(event), pan, start: worldPoint(event), additive: false, moved: false };
      setIsPanning(true);
    } else if (!readOnly && drawingTools.has(activeTool) && !layers.objects.locked) {
      gesture.current = { kind: "draw", screen: screenPoint(event), pan, start: clampPoint(worldPoint(event), bounds), additive: false, moved: false };
      creationDraft.current = null;
    } else if (!readOnly && activeTool === "select") {
      const hit = stage.current?.getIntersection(screenPoint(event));
      if (hit) return;
      gesture.current = { kind: "marquee", screen: screenPoint(event), pan, start: worldPoint(event), additive: event.shiftKey, moved: false };
      marqueeDraft.current = null;
      if (!event.shiftKey) useFloorEditorStore.getState().clearSelection();
    }
  }
  function move(event: MouseEvent<HTMLDivElement>) {
    const action = gesture.current; if (!action) return;
    const point = screenPoint(event);
    action.moved ||= Math.hypot(point.x - action.screen.x, point.y - action.screen.y) > 3;
    if (action.kind === "pan") return schedulePointerMove(() => {
      if (gesture.current !== action) return;
      const nextPan = { x: action.pan.x + point.x - action.screen.x, y: action.pan.y + point.y - action.screen.y };
      stage.current?.getLayers().forEach((layer) => layer.position(nextPan));
      setTransientPan(nextPan);
    });
    if (readOnly) return;
    const world = clampPoint(worldPoint(event), bounds);
    schedulePointerMove(() => {
      if (gesture.current !== action) return;
      if (action.kind === "draw") {
        const next = createObjectFromDrag(activeTool, action.start, world);
        creationDraft.current = next;
        setCreation(next);
      } else {
        const next = { x: Math.min(action.start.x, world.x), y: Math.min(action.start.y, world.y), width: Math.abs(world.x - action.start.x), height: Math.abs(world.y - action.start.y) };
        marqueeDraft.current = next;
        setMarquee(next);
      }
    });
  }
  function finish(event: MouseEvent<HTMLDivElement>) {
    flushPointerMove();
    const action = gesture.current; gesture.current = null;
    if (action?.kind === "pan") {
      const point = screenPoint(event);
      useFloorEditorStore.getState().setPan({ x: action.pan.x + point.x - action.screen.x, y: action.pan.y + point.y - action.screen.y });
      setTransientPan(null);
      setIsPanning(false);
    }
    if (!readOnly && action?.moved) {
      const completedCreation = creationDraft.current;
      const completedMarquee = marqueeDraft.current;
      if (action.kind === "draw" && completedCreation) useFloorEditorStore.getState().addObject(state!.floor.id, completedCreation);
      if (action.kind === "marquee" && completedMarquee && layers.fixtures.visible && !layers.fixtures.locked) useFloorEditorStore.getState().selectFixtures(state!.fixtures.filter((f) => f.placementStatus !== "unplaced" && !lockedSet.has(f.id) && f.x >= completedMarquee.x && f.x <= completedMarquee.x + completedMarquee.width && f.y >= completedMarquee.y && f.y <= completedMarquee.y + completedMarquee.height).map((f) => f.id), action.additive);
    }
    creationDraft.current = null; marqueeDraft.current = null; setCreation(null); setMarquee(null);
  }
  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (readOnly) return;
    if (event.dataTransfer.types.includes(FIXTURE_DRAG_TYPE) && !layers.fixtures.locked) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const pointer = { clientX: event.clientX, clientY: event.clientY };
      schedulePointerMove(() => {
        const current = useFloorEditorStore.getState();
        const point = worldPoint(pointer);
        const slot = findAvailableCadSlotAtPoint(availableSlotIndex, point, CAD_SLOT_HIT_RADIUS / current.zoom);
        setHighlightedSlotId(slot?.id ?? null);
        setDropPreview(slot ? { x: slot.x, y: slot.y } : point);
      });
    }
    else if (event.dataTransfer.types.includes(TOOL_DRAG_TYPE) && !layers.objects.locked) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    cancelPointerMove();
    setDropPreview(null); setHighlightedSlotId(null); if (readOnly) return;
    event.preventDefault();
    const current = useFloorEditorStore.getState();
    if (current.state?.floor.id !== state!.floor.id) return;
    const point = worldPoint(event);
    if (point.x < 0 || point.y < 0 || point.x > bounds.width || point.y > bounds.height) return;
    const id = event.dataTransfer.getData(FIXTURE_DRAG_TYPE);
    if (id) {
      const fixture = current.state.fixtures.find((f) => f.id === id);
      if (!fixture || fixture.placementStatus !== "unplaced" || current.layers.fixtures.locked || current.lockedFixtureIds.includes(id)) return;
      const slot = findAvailableCadSlotAtPoint(availableSlotIndex, point, CAD_SLOT_HIT_RADIUS / current.zoom);
      if (slot) {
        current.assignFixtureToSlot(id, slot.id);
        current.selectFixture(id);
        return;
      }
      current.placeFixtures([{ id, ...point }]); current.selectFixture(id); return;
    }
    const tool = event.dataTransfer.getData(TOOL_DRAG_TYPE) as EditorTool;
    if (drawingTools.has(tool)) current.addObject(current.state.floor.id, createDefaultObject(tool, point));
  }
  const transform = { x: renderedPan.x, y: renderedPan.y, scaleX: zoom, scaleY: zoom };
  const focusedFixture = layers.fixtures.visible && selection?.kind === "fixture" ? placedFixtureCollection.byId.get(selection.id) : undefined;
  const focusedLabel = focusedFixture ? selectedFixtureLabelLayout(focusedFixture, pan, zoom, viewport) : undefined;
  const selectedObjectType = selection?.kind === "object" ? objectCollection.byId.get(selection.id)?.type : undefined;
  const transformerAnchors = selection?.kind === "fixture"
    ? ["top-left", "top-right", "bottom-left", "bottom-right"]
    : selectedObjectType === "line"
      ? ["middle-left", "middle-right"]
      : ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"];
  return <div ref={container} className={`relative h-full min-h-105 w-full overflow-hidden bg-surface-canvas ${backgroundUrl ? "has-plan" : "grid-only"} ${activeTool === "pan" ? isPanning ? "cursor-grabbing" : "cursor-grab" : ""}`}
    aria-label={`${state.floor.name} 편집 캔버스`} aria-disabled={readOnly} data-testid="floor-editor-canvas" data-floor-id={state.floor.id} data-zoom={zoom} data-pan-x={pan.x} data-pan-y={pan.y}
    data-snap={snap} data-grid-size={floorPlan?.gridSize ?? 10} data-active-guides=""
    data-background-url={backgroundUrl} data-cad-candidate-count={cadCandidates.length}
    data-map-width={bounds.width} data-map-height={bounds.height}
    data-rendered-fixture-count={visibleFixtures.length} data-rendered-object-count={visibleObjects.length}
    onMouseDown={begin} onMouseMove={move} onMouseUp={finish} onMouseLeave={(e) => { if (gesture.current?.kind === "pan") finish(e); else { cancelPointerMove(); gesture.current = null; creationDraft.current = null; marqueeDraft.current = null; setTransientPan(null); setCreation(null); setMarquee(null); setIsPanning(false); } }}
    onDragOver={dragOver} onDragLeave={() => { cancelPointerMove(); setDropPreview(null); setHighlightedSlotId(null); }} onDrop={drop}>
    <Stage ref={stage} width={viewport.width} height={viewport.height} onWheel={(event) => {
      event.evt.preventDefault(); const store = useFloorEditorStore.getState();
      const point = stage.current?.getPointerPosition(); if (!point) return;
      const world = screenToWorld(point, store.pan, store.zoom);
      const next = Math.min(4, Math.max(0.1, store.zoom * (event.evt.deltaY > 0 ? 1 / 1.1 : 1.1)));
      useFloorEditorStore.setState({ zoom: next, pan: { x: point.x - world.x * next, y: point.y - world.y * next } });
    }}>
      <Layer {...transform} name="editor-static-layer" listening={false}>
        <Rect width={bounds.width} height={bounds.height} fill={editorColors.panel} stroke={editorColors.border} strokeWidth={1} />
        {background && layers.background.visible && <KonvaImage image={background} width={bounds.width} height={bounds.height} />}
        {snap ? <MapGrid width={bounds.width} height={bounds.height} gridSize={floorPlan?.gridSize ?? 10} zoom={zoom} color={editorColors.grid} /> : null}
        {!onToggleCadCandidate ? <CadPlacementSlotLayer
          slotIndex={availableSlotIndex}
          zoom={zoom}
          viewportBounds={viewportBounds}
          highlightedSlotId={highlightedSlotId}
        /> : null}
      </Layer>
      <CadCandidateLayer
        candidates={cadCandidates}
        acceptedCandidateIds={acceptedCadCandidateIds}
        transform={transform}
        zoom={zoom}
        viewportBounds={viewportBounds}
        disabled={!onFocusedCadCandidateChange && !onToggleCadCandidate}
        focusedCandidateId={focusedCadCandidateId}
        onFocusedCandidateChange={onFocusedCadCandidateChange}
        onToggle={onToggleCadCandidate}
      />
      <Layer {...transform} name="editor-object-layer" visible={layers.objects.visible} listening={!readOnly && !layers.objects.locked && activeTool === "select"}>
        {visibleObjects.map((object) => {
          let ref = objectRefCallbacks.current.get(object.id);
          if (!ref) { ref = (node) => { if (node) objectNodes.current.set(object.id, node); else objectNodes.current.delete(object.id); }; objectRefCallbacks.current.set(object.id, ref); }
          return <FloorMapObjectNode key={object.id} object={object} interactive={!readOnly && !layers.objects.locked && !object.locked && activeTool === "select"} selected={selection?.id === object.id}
            setNodeRef={ref} onSelect={() => useFloorEditorStore.getState().selectObject(object.id)}
            onDragStart={() => {
              if (beginDragInteraction("object", object.id) === null) return;
              const store = useFloorEditorStore.getState();
              guideTargets.current = collectGuideTargets(store.state, new Set(), object.id);
            }}
            onDragMove={(node) => {
              const token = dragInteraction.current?.token ?? null;
              scheduleDragMove(() => {
                if (!isDragInteractionCurrent(token, "object", object.id)) return;
                const store = useFloorEditorStore.getState();
                const moving = clampObjectToMap({ x: node.x(), y: node.y(), width: object.width, height: object.height }, bounds);
                const aligned = alignRectToGuides(moving, guideTargets.current, bounds, 6 / store.zoom);
                node.position(aligned.point);
                renderAlignmentGuides(aligned.guides);
              });
            }}
            onChange={(patch) => {
              const token = dragInteraction.current?.token ?? null;
              flushDragMove();
              if (isDragInteractionCurrent(token, "object", object.id)) {
                useFloorEditorStore.getState().updateObject(object.id, clampPoint({ x: patch.x ?? object.x, y: patch.y ?? object.y }, bounds));
              }
              cancelDragInteraction();
            }}
            onTransformEnd={(node) => {
              if (readOnly) return;
              const width = Math.max(24, object.width * node.scaleX()); const height = object.type === "line" ? 0 : Math.max(24, object.height * node.scaleY()); node.scale({ x: 1, y: 1 });
              useFloorEditorStore.getState().updateObject(object.id, { ...clampPoint({ x: node.x(), y: node.y() }, bounds), width, height, points: object.type === "triangle" ? trianglePoints(width, height) : object.points });
            }} />;
        })}
      </Layer>
      <Layer {...transform} name="editor-fixture-layer" visible={layers.fixtures.visible} listening={activeTool === "select"}>
        {visibleFixtures.map((fixture) => <EditorFixtureNode key={fixture.id} fixture={fixture} selected={selectedSet.has(fixture.id)} interactive={!readOnly && activeTool === "select" && !layers.fixtures.locked && !lockedSet.has(fixture.id)} showName={showBulkNames && !selectedSet.has(fixture.id)} zoom={zoom} colors={fixtureColors} register={register} onSelect={onSelect} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onTransform={onTransform} />)}
      </Layer>
      <Layer {...transform} name="editor-overlay-layer">
        <Line ref={verticalGuide} name="alignment-guide-vertical" visible={false} listening={false} stroke={editorColors.guide} strokeWidth={1 / zoom} dash={[6 / zoom, 4 / zoom]} />
        <Line ref={horizontalGuide} name="alignment-guide-horizontal" visible={false} listening={false} stroke={editorColors.guide} strokeWidth={1 / zoom} dash={[6 / zoom, 4 / zoom]} />
        {creation && <FloorMapObjectNode object={{ ...creation, id: "creation", zIndex: 999 }} interactive={false} preview />}
        {marquee && <Rect {...marquee} fill={editorColors.marquee} stroke={editorColors.selected} strokeWidth={1 / zoom} listening={false} />}
        {preview.map((p) => <Circle key={p.id} x={p.x} y={p.y} radius={10} fill={editorColors.preview} opacity={0.65} listening={false} />)}
        {dropPreview && <Circle x={dropPreview.x} y={dropPreview.y} radius={10} stroke={editorColors.selected} fill={editorColors.fixtureFill} listening={false} />}
        <Transformer ref={transformer} rotateEnabled={false} keepRatio={selection?.kind === "fixture"} flipEnabled={false} enabledAnchors={transformerAnchors} boundBoxFunc={(oldBox, box) => box.width < 4 || box.height < 4 ? oldBox : box} />
        {focusedFixture && focusedLabel && <Label name="selected-fixture-label" x={focusedLabel.x} y={focusedLabel.y} scaleX={focusedLabel.scaleX} scaleY={focusedLabel.scaleY} listening={false}>
          <Tag fill={editorColors.panel} stroke={editorColors.border} strokeWidth={1} cornerRadius={4} />
          <Text name="selected-fixture-name" text={focusedFixture.name} width={focusedLabel.width} height={focusedLabel.height} padding={6} fontSize={12} fontStyle="bold" fill={editorColors.label} ellipsis wrap="none" verticalAlign="middle" />
        </Label>}
      </Layer>
    </Stage>
    {backgroundStatus === "error" ? <div className="absolute inset-x-3 top-3 z-5 flex items-center justify-between gap-3 border border-status-danger-border bg-surface-panel p-3 shadow-panel" role="alert">
      <span className="text-body-sm font-semibold text-status-danger-foreground">CAD 도면을 표시하지 못했습니다.</span>
      <Button size="sm" variant="secondary" onClick={retryBackground}>도면 다시 시도</Button>
    </div> : null}
    <FixturePlacementAction readOnly={readOnly} rowRegistry={rowRegistry} />
    <EditorMinimap />
  </div>;
}

function fixtureRect(fixture: Pick<EditorFixture, "x" | "y" | "size">): MapRect {
  const size = fixture.size ?? 20;
  return { x: fixture.x - size / 2, y: fixture.y - size / 2, width: size, height: size };
}

function fixtureGroupRect(fixtures: Array<Pick<EditorFixture, "x" | "y" | "size">>, delta: Point): MapRect {
  const rects = fixtures.map(fixtureRect);
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left + delta.x, y: top + delta.y, width: right - left, height: bottom - top };
}

function collectGuideTargets(state: FloorEditorState | null, excludedFixtures: Set<string>, excludedObjectId?: string): MapRect[] {
  if (!state) return [];
  return [
    ...state.fixtures
      .filter((fixture) => fixture.placementStatus !== "unplaced" && !excludedFixtures.has(fixture.id))
      .map(fixtureRect),
    ...state.objects
      .filter((object) => object.visible && object.id !== excludedObjectId)
      .map((object) => ({ x: object.x, y: object.y, width: object.width, height: object.height }))
  ];
}

function MapGrid({ width, height, gridSize, zoom, color }: { width: number; height: number; gridSize: number; zoom: number; color: string }) {
  const lineCount = width / gridSize + height / gridSize;
  const displayStep = gridSize * Math.max(1, Math.ceil(lineCount / 2_000));
  return (
    <Shape
      name="map-grid"
      listening={false}
      stroke={color}
      strokeWidth={1 / zoom}
      opacity={0.65}
      sceneFunc={(context, shape) => {
        context.beginPath();
        for (let x = displayStep; x < width; x += displayStep) {
          context.moveTo(x, 0);
          context.lineTo(x, height);
        }
        for (let y = displayStep; y < height; y += displayStep) {
          context.moveTo(0, y);
          context.lineTo(width, y);
        }
        context.strokeShape(shape);
      }}
    />
  );
}
