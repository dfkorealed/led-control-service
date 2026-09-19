import type { MapDocumentRef, MapElement, MapGroup, MapLayer, MapOp } from "@led-control/shared/map-document-contracts";
import type { MapDocumentSource, MapSelectionInput } from "../../api/map-document";

type SelectionSource = Pick<MapDocumentSource, "getSelection" | "getElements">;
export interface MapSelectionQuery {
  document: MapDocumentRef;
  selection: { elementIds: string[]; groupIds: string[] };
  source: SelectionSource;
  operations: readonly MapOp[];
  groups: ReadonlyMap<string, MapGroup>;
  signal: AbortSignal;
  filter?: MapSelectionInput;
}

export function mapGroupContains(groupId: string | null, ancestors: ReadonlySet<string>, groups: ReadonlyMap<string, MapGroup>): boolean {
  const visited = new Set<string>();
  while (groupId !== null) {
    if (ancestors.has(groupId)) return true;
    if (visited.has(groupId)) throw new Error("그룹 참조가 올바르지 않습니다.");
    visited.add(groupId);
    groupId = groups.get(groupId)?.parentId ?? null;
  }
  return false;
}


export function isMapSelectionLocked(elements: readonly MapElement[], groups: ReadonlyMap<string, MapGroup>, layers: ReadonlyMap<string, MapLayer>): boolean {
  const locked = new Set([...groups.values()].filter(group => group.locked).map(group => group.id));
  return elements.some(element => element.locked || !layers.has(element.layerId) || layers.get(element.layerId)!.locked
    || mapGroupContains(element.groupId, locked, groups));
}

export function planMapUngroup(group: MapGroup, elements: readonly MapElement[], groups: readonly MapGroup[]): MapOp[] {
  return [
    ...elements.filter(element => element.groupId === group.id).map(element => ({ kind: "update" as const, element: { ...element, groupId: group.parentId } })),
    ...groups.filter(child => child.parentId === group.id).map(child => ({ kind: "group.put" as const, group: { ...child, parentId: group.parentId } })),
    { kind: "group.delete", id: group.id }
  ];
}

export function planMapLayerRemoval(id: string, targetId: string, elements: readonly MapElement[]): MapOp[] {
  if (!targetId || targetId === id) throw new Error("이동할 다른 레이어를 선택해주세요.");
  return [...elements.map(element => ({ kind: "update" as const, element: { ...element, layerId: targetId } })), { kind: "layer.delete", id }];
}

export function isEditorTextTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], [role=spinbutton], [role=textbox]"));
}
