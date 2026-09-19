import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapElement, MapOp, Point } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { createMapDocumentSource, type MapSelectionInput } from "../../api/map-document";
import { ApiError } from "../../api/client";
import type { MapSceneCanvasHandle } from "../map-scene/MapSceneCanvas";
import type { MapSceneManifest } from "../map-scene/map-scene-source";
import { hitMapElement } from "../map-scene/map-scene-geometry";
import { useFloorEditorStore } from "./editor-store";
import { getMapElementOverlaySelection } from "./MapElementOverlay";
import { getMapSelectionBounds, transformMapSelection } from "./map-element-editing";
import { isMapSelectionLocked, mapGroupContains } from "./map-editor-selection";
import { inspectMapSelection, streamMapSelection, type MapSelectionStreamQuery, type MapSelectionSummary } from "./map-editor-selection-stream";
import { fitSelectionCamera, selectionFixtureBounds, transformSelectedFixtures } from "./map-selection-transform";
import { addMapPolygonHole, removeMapPolygonHole } from "./map-element-tools";

export type MapEditorController = ReturnType<typeof useMapEditor>;
const EMPTY_SELECTION: MapSelectionSummary = { count: 0, bounds: null, inline: [], locked: false };

/** UI orchestration only. Canonical edits, drafts, history and saved state all
 * remain in the existing floor editor store; resolved originals are selection-local. */
export function useMapEditor({ floorId, authScope, readOnly, lease }: { floorId: string; authScope: string; readOnly: boolean; lease?: { leaseToken: string; leaseFence: number } }) {
  const pendingStage = useFloorEditorStore(s => s.pendingMapStage);
  const preparing = useFloorEditorStore(s => s.isPreparingMapStage);
  const document = useFloorEditorStore(s => s.state?.floor.id === floorId ? s.pendingMapStage?.preview ?? s.state.floor.mapDocument : null);
  const floorPlan = useFloorEditorStore(s => s.state?.floor.floorPlan);
  const mapBounds = useMemo(() => document ? { width: floorPlan?.width ?? document.width, height: floorPlan?.height ?? document.height,
    gridSize: floorPlan?.gridSize ?? document.gridSize } : null, [document, floorPlan]);
  const scope = useFloorEditorStore(s => s.mapScope);
  const selected = useFloorEditorStore(s => s.mapSelection);
  const operations = useFloorEditorStore(s => s.mapOperations);
  const groups = useFloorEditorStore(s => s.mapGroups);
  const layers = useFloorEditorStore(s => s.mapLayers);
  const fixtures = useFloorEditorStore(s => s.state?.fixtures);
  const fixtureIds = useFloorEditorStore(s => s.selectedFixtureIds);
  const fixtureLocks = useFloorEditorStore(s => s.lockedFixtureIds);
  const fixtureLayerLocked = useFloorEditorStore(s => s.layers.fixtures.locked);
  const selectedFixtures = useMemo(() => fixtures?.filter(f => fixtureIds.includes(f.id) && f.placementStatus !== "unplaced") ?? [], [fixtures, fixtureIds]);
  const source = useMemo(() => createMapDocumentSource({ floorId, authScope, ...(pendingStage ? { stageId: pendingStage.stageId } : {}) }), [floorId, authScope, pendingStage?.stageId]);
  const handle = useRef<MapSceneCanvasHandle | null>(null);
  const [ready, setReady] = useState<MapSceneCanvasHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ selected: typeof selected; scope: typeof scope; filters: MapSelectionInput[] } | null>(null);
  const filters = range?.selected === selected && range.scope === scope ? range.filters : undefined;
  const [resolved, setResolved] = useState<{ key: string; operations: typeof operations; summary: MapSelectionSummary } | null>(null);
  const [retryStage, setRetryStage] = useState<(() => Promise<unknown>) | null>(null);
  const validation = useRef<AbortController | null>(null);
  const [validating, setValidating] = useState(false);
  const context = JSON.stringify([floorId, authScope]);
  const currentContext = useRef(context); currentContext.current = context;
  useEffect(() => {
    setRetryStage(null); setError(null); setValidating(false);
    return () => { validation.current?.abort(); validation.current = null; };
  }, [context]);
  const [overlayFailed, setOverlayFailed] = useState(false);
  const [holeKey, setHoleKey] = useState<string | null>(null);
  const pickEpoch = useRef(0);
  const key = JSON.stringify([scope, selected, filters]);
  const hasSelection = Boolean(selected.elementIds.length || selected.groupIds.length || filters?.length);
  const summary = useMemo(() => {
    if (!hasSelection) return EMPTY_SELECTION;
    if (resolved?.key !== key) return null;
    if (resolved.operations === operations) return resolved.summary;
    // Explicit bounded IDs stay mounted while typing a property. A fresh async
    // summary is still required for query membership or streamed selections.
    if (!resolved.summary.inline || selected.groupIds.length || filters) return null;
    const values = new Map(resolved.summary.inline.map(element => [element.id, element]));
    for (const op of operations) {
      if (op.kind === "delete") values.delete(op.id);
      else if ((op.kind === "add" || op.kind === "update") && selected.elementIds.includes(op.element.id)) values.set(op.element.id, op.element);
    }
    const inline = [...values.values()];
    return { count: inline.length, bounds: getMapSelectionBounds(inline), inline, locked: isMapSelectionLocked(inline, groups, layers) };
  }, [hasSelection, resolved, key, operations, selected, filters, groups, layers]);
  const selection = useMemo(() => summary?.inline ?? [], [summary]);
  const selectionCount = summary?.count ?? 0;
  const query = useMemo(() => document && scope ? { document, selection: selected, source, operations, groups, layers,
    ...(filters ? { filters: [...selected.groupIds.map(groupId => ({ groupId })), ...filters] } : {}) } : null,
  [document, scope, selected, source, operations, groups, layers, filters]);
  const reportError = useCallback((error: unknown) => {
    setOverlayFailed(true);
    try { handle.current?.setPromotedElementIds([]); } catch { /* A disposed surface already has no promotion mask. */ }
    setError(error instanceof ApiError && error.status === 409 ? "맵이 변경되었습니다. 초안을 보존한 상태로 최신 맵을 다시 불러와주세요."
      : error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "맵을 불러오거나 편집하지 못했습니다. 다시 시도해주세요.");
  }, []);
  const onReady = useCallback((next: MapSceneCanvasHandle | null) => { handle.current = next; setReady(next); }, []);
  const onManifest = useCallback((manifest: MapSceneManifest) => {
    const current = useFloorEditorStore.getState();
    if (!scope || current.mapScope !== scope || manifest.generationId !== scope.generationId || manifest.revision !== scope.baseRevision) return;
    try { current.loadMapStructures(scope, { groups: manifest.groups, layers: manifest.layers }); setError(null); }
    catch (error) { reportError(error); }
  }, [scope, reportError]);

  useEffect(() => {
    setOverlayFailed(false);
    if (!hasSelection || !query || !scope || scope.floorId !== floorId) return;
    const controller = new AbortController();
    void inspectMapSelection({ ...query, signal: controller.signal })
      .then(summary => {
        if (controller.signal.aborted || useFloorEditorStore.getState().mapScope !== scope) return;
        if (filters && summary.inline) {
          // Small ranges become stable explicit selections so moving outside the
          // original marquee does not silently drop members or break undo selection.
          setRange(null);
          useFloorEditorStore.getState().selectMapElements(summary.inline.map(element => element.id), true);
          return;
        }
        setResolved({ key, operations, summary });
      }).catch(error => { if (!controller.signal.aborted) reportError(error); });
    return () => controller.abort();
  }, [hasSelection, query, scope, floorId, operations, key, filters, reportError]);

  useEffect(() => {
    if (!ready || !document || readOnly) return;
    try {
      ready.setDraftChanges([...operations], operations.flatMap(op => op.kind === "add" || op.kind === "update" ? [getMapElementBounds(op.element)] : []));
    } catch (error) { reportError(error); }
  }, [ready, document, operations, readOnly, reportError]);

  const locked = Boolean(summary?.locked || selectedFixtures.length && (fixtureLayerLocked || selectedFixtures.some(f => fixtureLocks.includes(f.id))));
  const bounds = useMemo(() => selectionFixtureBounds(summary?.bounds ?? null, selectedFixtures), [summary, selectedFixtures]);
  const promotedIds = useMemo(() => {
    if (overlayFailed || selectedFixtures.length) return [];
    const hiddenGroups = new Set([...groups.values()].filter(group => !group.visible).map(group => group.id));
    // Do not rewrite canonical visibility to accommodate inherited hide state:
    // that would turn a transform into an unintended visibility edit.
    if (selection.some(element => !layers.get(element.layerId)?.visible || mapGroupContains(element.groupId, hiddenGroups, groups))) return [];
    try { return getMapElementOverlaySelection(selection).map(element => element.id); }
    catch { return []; }
  }, [selection, groups, layers, overlayFailed, selectedFixtures]);

  const commit = useCallback((ops: MapOp[], originals: MapElement[] = selection) => {
    if (readOnly || preparing || !scope || useFloorEditorStore.getState().mapScope !== scope) return false;
    try {
      useFloorEditorStore.getState().applyMapTransaction({ operations: ops, scope, canonicalElements: originals });
      setError(null); return true;
    } catch (error) { reportError(error); return false; }
  }, [readOnly, preparing, scope, selection, reportError]);
  const create = useCallback((element: MapElement) => {
    if (commit([{ kind: "add", element }], [])) useFloorEditorStore.getState().selectMapElements([element.id]);
  }, [commit]);
  const runStage = useCallback(async (run: () => Promise<unknown>) => {
    setRetryStage(() => run);
    try { const result = await run();
      if (currentContext.current !== context) return false;
      if (result !== "stale") { setRetryStage(null); setError(null); } return result !== "stale";
    } catch (error) { if (currentContext.current === context) reportError(error); return false; }
  }, [context, reportError]);
  const edit = useCallback(async (input: Omit<MapSelectionStreamQuery, "signal">, known: MapSelectionSummary | null,
    mapper: (element: MapElement) => MapOp[], before: MapOp[] = [], after: MapOp[] = [], fixtureUpdates: Array<{ id: string; x: number; y: number }> = []) => {
    if (readOnly || preparing || validation.current || !scope || useFloorEditorStore.getState().mapScope !== scope) return false;
    const controller = new AbortController(), signal = controller.signal;
    validation.current = controller;
    const current = () => {
      const store = useFloorEditorStore.getState();
      if (store.mapScope !== scope || store.mapOperations !== operations) throw new Error("맵이 변경되었습니다. 다시 선택해주세요.");
    };
    try {
      const all = known ?? await inspectMapSelection({ ...input, signal }); current();
      if (all.locked) throw new Error("잠금을 해제한 뒤 선택을 편집해주세요.");
      if (all.inline) {
        const ops = [...before, ...all.inline.flatMap(mapper), ...after];
        useFloorEditorStore.getState().applyMapTransaction({ operations: ops, canonicalElements: all.inline, scope, fixtureUpdates, preserveFixturePositions: true });
        setError(null); return true;
      }
      setValidating(true);
      if (!lease) throw new Error("편집 권한을 다시 확인해주세요.");
      if (useFloorEditorStore.getState().isDirty) throw new Error("대량 편집 전에 현재 변경사항을 저장하거나 취소해주세요.");
      // Validate the complete geometry before a stage can capture fixture patches.
      // The second pass reads the same immutable revision with bounded memory.
      for await (const element of streamMapSelection({ ...input, signal })) { current(); mapper(element); }
      const factory = async function* () {
        const checkScope = () => { if (useFloorEditorStore.getState().mapScope !== scope) throw new Error("맵이 변경되었습니다. 다시 선택해주세요."); };
        checkScope(); yield* before;
        for await (const element of streamMapSelection({ ...input, signal })) { checkScope(); yield* mapper(element); }
        yield* after;
      };
      const transaction = { scope, operations: factory, fixtureUpdates, preserveFixturePositions: true };
      return await runStage(() => useFloorEditorStore.getState().prepareMapStream(transaction, lease));
    } catch (error) { if (!signal.aborted && useFloorEditorStore.getState().mapScope === scope) reportError(error); return false; }
    finally { if (validation.current === controller) { validation.current = null; setValidating(false); } }
  }, [readOnly, preparing, scope, operations, lease, runStage, reportError]);
  const editSelection = useCallback((mapper: (element: MapElement) => MapOp[], before?: MapOp[], after?: MapOp[]) =>
    query && summary ? edit(query, summary, mapper, before, after) : Promise.resolve(false), [query, summary, edit]);
  const editQuery = useCallback((filter: MapSelectionInput, mapper: (element: MapElement) => MapOp[], before?: MapOp[], after?: MapOp[]) =>
    query ? edit({ ...query, selection: { elementIds: [], groupIds: [] }, filters: [filter] }, null, mapper, before, after) : Promise.resolve(false), [query, edit]);
  const remove = useCallback(async () => {
    if (await editSelection(element => [{ kind: "delete", id: element.id }])) useFloorEditorStore.getState().clearSelection();
  }, [editSelection]);
  const transform = useCallback(async (delta: MapElement["transform"]) => {
    if (!mapBounds || locked || !query || !summary) return;
    try { await edit(query, summary, element => transformMapSelection([element], delta, mapBounds), [], [], transformSelectedFixtures(selectedFixtures, delta, mapBounds)); }
    catch (error) { reportError(error); }
  }, [mapBounds, locked, query, summary, edit, selectedFixtures, reportError]);
  const move = useCallback((delta: Point) => transform({ ...delta, scaleX: 1, scaleY: 1, rotation: 0 }), [transform]);
  const fitSelection = useCallback(() => {
    if (!bounds) return;
    const store = useFloorEditorStore.getState(), camera = fitSelectionCamera(bounds, store.viewport);
    store.setZoom(camera.zoom); store.setPan(camera.pan);
  }, [bounds]);
  const history = useCallback(async (direction: "undo" | "redo") => {
    if (readOnly || preparing) return;
    const store = useFloorEditorStore.getState(), entry = (direction === "undo" ? store.past : store.future).at(-1);
    try {
      if (entry?.external) {
        if (!lease) throw new Error("편집 권한을 다시 확인해주세요.");
        await runStage(() => useFloorEditorStore.getState().prepareHistory(direction, lease));
      } else store[direction]();
    } catch (error) { reportError(error); }
  }, [readOnly, preparing, lease, runStage, reportError]);
  const cancelStage = useCallback(async () => {
    if (validation.current && !useFloorEditorStore.getState().isPreparingMapStage && !useFloorEditorStore.getState().pendingMapStage) {
      validation.current.abort(); validation.current = null; setValidating(false); return;
    }
    if (!lease) return;
    try {
      const result = await useFloorEditorStore.getState().cancelMapStage(lease);
      if (currentContext.current !== context) return "stale";
      if (result !== "stale") { setRetryStage(null); setError(null); }
      return result;
    }
    catch (error) { if (currentContext.current === context) reportError(error); }
  }, [lease, context, reportError]);
  const selectQuery = useCallback((filter: MapSelectionInput, additive = false, fixtures: string[] = []) => {
    if (readOnly || preparing) return;
    const store = useFloorEditorStore.getState();
    if (!additive) store.clearSelection();
    store.selectFixtures(fixtures, true);
    setRange({ selected: useFloorEditorStore.getState().mapSelection, scope,
      filters: [...(additive ? filters ?? [] : []), filter] });
  }, [readOnly, preparing, scope, filters]);
  const pick = useCallback(async (point: Point, child: boolean, additive: boolean) => {
    const captured = useFloorEditorStore.getState().mapScope;
    const epoch = ++pickEpoch.current;
    const selectPicked = (element: MapElement) => {
      const current = useFloorEditorStore.getState(), previous = current.mapSelection;
      if (!child && element.groupId) current.selectMapGroups([element.groupId], additive);
      else current.selectMapElements([element.id], additive);
      const next = useFloorEditorStore.getState().mapSelection;
      // Only this additive mutation may carry the query forward. Replacement,
      // external selection changes and scope switches still invalidate it.
      setRange(range => additive && range?.scope === captured && range.selected === previous
        ? { ...range, selected: next } : null);
    };
    try {
      // Promoted originals are deliberately masked out of renderer picking.
      // Resolve child entry against the exact selected canonical geometries.
      if (child && promotedIds.length) {
        const current = useFloorEditorStore.getState();
        const world = { x: (point.x - current.pan.x) / current.zoom, y: (point.y - current.pan.y) / current.zoom };
        const local = selection.filter(element => promotedIds.includes(element.id) && element.visible)
          .sort((a, b) => (layers.get(b.layerId)?.order ?? 0) - (layers.get(a.layerId)?.order ?? 0) || b.zIndex - a.zIndex)
          .find(element => hitMapElement(element, world, 4 / current.zoom, current.zoom));
        if (local) { selectPicked(local); return; }
      }
      const result = await handle.current?.pick(point);
      const current = useFloorEditorStore.getState();
      if (!captured || current.mapScope !== captured || epoch !== pickEpoch.current) return;
      if (!result) { if (!additive) current.clearSelection(); return; }
      selectPicked(result.element);
    } catch (error) { reportError(error); }
  }, [reportError, promotedIds, selection, layers]);
  const polygon = selection.length === 1 && selection[0].type === "polygon" ? selection[0] : null;
  const holeActive = holeKey === key && polygon !== null;
  const beginHole = () => { if (polygon && !readOnly && !locked) setHoleKey(key); };
  const finishHole = (points: Point[]) => {
    if (!holeActive || !polygon || locked || readOnly) return false;
    const { x, y, scaleX, scaleY, rotation } = polygon.transform;
    const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    // Pointer coordinates are world-space; polygon rings are canonical-local.
    // Undo translation/rotation before nonuniform scale, exactly once.
    const local = points.map(point => ({ x: ((point.x - x) * cos + (point.y - y) * sin) / scaleX,
      y: (-(point.x - x) * sin + (point.y - y) * cos) / scaleY }));
    const next = addMapPolygonHole(polygon, local);
    if (!next) { reportError(new Error("구멍은 다각형 안쪽에서 겹치지 않는 닫힌 경계여야 합니다.")); return false; }
    if (!commit([{ kind: "update", element: next }])) return false;
    setHoleKey(null); return true;
  };
  const removeHole = (index: number) => {
    if (!polygon || locked || readOnly) return;
    const next = removeMapPolygonHole(polygon, index);
    if (next) commit([{ kind: "update", element: next }]);
  };
  return { source, document, mapBounds, handle, ready: Boolean(ready), onReady, onManifest, reportError, error, clearError: () => setError(null),
    selection, selectionCount, selectionKey: key, bounds, locked, promotedIds, commit, create, remove, move, transform, pick, selectQuery, editQuery, editSelection, fitSelection,
    mixed: Boolean(selectionCount && selectedFixtures.length), preparing: preparing || validating, pendingStage, retryStage: retryStage ? () => runStage(retryStage) : null, cancelStage, history,
    polygon, holeActive, beginHole, finishHole, removeHole, cancelHole: () => setHoleKey(null),
    loadingSelection: Boolean(query && !summary),
    readOnly };
}
