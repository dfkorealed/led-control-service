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
import { isMapSelectionLocked, mapGroupContains, resolveMapSelection } from "./map-editor-selection";
import { addMapPolygonHole, removeMapPolygonHole } from "./map-element-tools";

export type MapEditorController = ReturnType<typeof useMapEditor>;

/** UI orchestration only. Canonical edits, drafts, history and saved state all
 * remain in the existing floor editor store; resolved originals are selection-local. */
export function useMapEditor({ floorId, authScope, readOnly }: { floorId: string; authScope: string; readOnly: boolean }) {
  const document = useFloorEditorStore(s => s.state?.floor.id === floorId ? s.state.floor.mapDocument : null);
  const scope = useFloorEditorStore(s => s.mapScope);
  const selected = useFloorEditorStore(s => s.mapSelection);
  const operations = useFloorEditorStore(s => s.mapOperations);
  const groups = useFloorEditorStore(s => s.mapGroups);
  const layers = useFloorEditorStore(s => s.mapLayers);
  const source = useMemo(() => createMapDocumentSource({ floorId, authScope }), [floorId, authScope]);
  const handle = useRef<MapSceneCanvasHandle | null>(null);
  const [ready, setReady] = useState<MapSceneCanvasHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{ key: string; elements: MapElement[] } | null>(null);
  const [overlayFailed, setOverlayFailed] = useState(false);
  const [holeKey, setHoleKey] = useState<string | null>(null);
  const pickEpoch = useRef(0);
  const key = JSON.stringify([scope, selected]);
  const selection = useMemo(() => {
    if (resolved?.key !== key) return [];
    const current = new Map(resolved.elements.map(element => [element.id, element]));
    for (const op of operations) {
      if (op.kind === "delete") current.delete(op.id);
      else if ((op.kind === "add" || op.kind === "update") && current.has(op.element.id)) current.set(op.element.id, op.element);
    }
    return [...current.values()];
  }, [resolved, key, operations]);
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
    if (!document || !scope || scope.floorId !== floorId || (!selected.elementIds.length && !selected.groupIds.length)) return;
    const controller = new AbortController();
    void resolveMapSelection({ document, selection: selected, source, operations, groups, signal: controller.signal })
      .then(elements => {
        if (controller.signal.aborted || useFloorEditorStore.getState().mapScope !== scope) return;
        setResolved({ key, elements });
      }).catch(error => { if (!controller.signal.aborted) reportError(error); });
    return () => controller.abort();
  }, [document, scope, floorId, selected, source, operations, groups, key, reportError]);

  useEffect(() => {
    if (!ready || !document || readOnly) return;
    try {
      ready.setDraftChanges([...operations], operations.flatMap(op => op.kind === "add" || op.kind === "update" ? [getMapElementBounds(op.element)] : []));
    } catch (error) { reportError(error); }
  }, [ready, document, operations, readOnly, reportError]);

  const locked = isMapSelectionLocked(selection, groups, layers);
  const bounds = useMemo(() => getMapSelectionBounds(selection), [selection]);
  const promotedIds = useMemo(() => {
    if (overlayFailed) return [];
    const hiddenGroups = new Set([...groups.values()].filter(group => !group.visible).map(group => group.id));
    // Do not rewrite canonical visibility to accommodate inherited hide state:
    // that would turn a transform into an unintended visibility edit.
    if (selection.some(element => !layers.get(element.layerId)?.visible || mapGroupContains(element.groupId, hiddenGroups, groups))) return [];
    try { return getMapElementOverlaySelection(selection).map(element => element.id); }
    catch { return []; }
  }, [selection, groups, layers, overlayFailed]);

  const commit = useCallback((ops: MapOp[], originals: MapElement[] = selection) => {
    if (readOnly || !scope || useFloorEditorStore.getState().mapScope !== scope) return false;
    try {
      useFloorEditorStore.getState().applyMapTransaction({ operations: ops, scope, canonicalElements: originals });
      setError(null); return true;
    } catch (error) { reportError(error); return false; }
  }, [readOnly, scope, selection, reportError]);
  const create = useCallback((element: MapElement) => {
    if (commit([{ kind: "add", element }], [])) useFloorEditorStore.getState().selectMapElements([element.id]);
  }, [commit]);
  const remove = useCallback(() => {
    if (locked || !selection.length) return;
    if (commit(selection.map(element => ({ kind: "delete", id: element.id })))) useFloorEditorStore.getState().clearSelection();
  }, [locked, selection, commit]);
  const move = useCallback((delta: Point) => {
    if (!document || locked) return;
    try { commit(transformMapSelection(selection, { ...delta, scaleX: 1, scaleY: 1, rotation: 0 }, document)); }
    catch (error) { reportError(error); }
  }, [document, locked, selection, commit, reportError]);
  const pick = useCallback(async (point: Point, child: boolean, additive: boolean) => {
    const captured = useFloorEditorStore.getState().mapScope;
    const epoch = ++pickEpoch.current;
    try {
      // Promoted originals are deliberately masked out of renderer picking.
      // Resolve child entry against the exact selected canonical geometries.
      if (child && promotedIds.length) {
        const current = useFloorEditorStore.getState();
        const world = { x: (point.x - current.pan.x) / current.zoom, y: (point.y - current.pan.y) / current.zoom };
        const local = selection.filter(element => promotedIds.includes(element.id) && element.visible)
          .sort((a, b) => (layers.get(b.layerId)?.order ?? 0) - (layers.get(a.layerId)?.order ?? 0) || b.zIndex - a.zIndex)
          .find(element => hitMapElement(element, world, 4 / current.zoom, current.zoom));
        if (local) { current.selectMapElements([local.id], additive); return; }
      }
      const result = await handle.current?.pick(point);
      const current = useFloorEditorStore.getState();
      if (!captured || current.mapScope !== captured || epoch !== pickEpoch.current) return;
      if (!result) { if (!additive) current.clearSelection(); return; }
      if (!child && result.element.groupId) current.selectMapGroups([result.element.groupId], additive);
      else current.selectMapElements([result.element.id], additive);
    } catch (error) { reportError(error); }
  }, [reportError, promotedIds, selection, layers]);
  const resolve = useCallback(async (filter: MapSelectionInput) => {
    if (!document || !scope) throw new Error("맵을 먼저 불러와주세요.");
    const elements = await resolveMapSelection({ document, selection: { elementIds: [], groupIds: filter.groupId ? [filter.groupId] : [] },
      source, operations, groups, filter, signal: new AbortController().signal });
    if (useFloorEditorStore.getState().mapScope !== scope || useFloorEditorStore.getState().mapOperations !== operations) throw new Error("맵이 변경되었습니다. 다시 선택해주세요.");
    return elements;
  }, [document, scope, source, operations, groups]);
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
  return { source, document, handle, ready: Boolean(ready), onReady, onManifest, reportError, error, clearError: () => setError(null),
    selection, selectionKey: key, bounds, locked, promotedIds, commit, create, remove, move, pick, resolve,
    polygon, holeActive, beginHole, finishHole, removeHole, cancelHole: () => setHoleKey(null),
    loadingSelection: Boolean(document && (selected.elementIds.length || selected.groupIds.length) && resolved?.key !== key),
    readOnly };
}
