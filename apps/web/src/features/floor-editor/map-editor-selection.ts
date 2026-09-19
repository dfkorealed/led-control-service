import type { MapDocumentRef, MapElement, MapGroup, MapLayer, MapOp } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
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

/** Resolve complete server membership, then overlay draft membership. Never use
 * the sparse store cache as a group's inventory or return a successful prefix.
 * U8c will replace the bounded affected-original path with external inverses. */
export async function resolveMapSelection(input: MapSelectionQuery): Promise<MapElement[]> {
  const { document, source, signal, selection, operations, groups } = input;
  signal.throwIfAborted();
  const ids = new Set(selection.elementIds);
  const filters = input.filter ? [input.filter] : selection.groupIds.map(groupId => ({ groupId }));
  for (const filter of filters) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      signal.throwIfAborted();
      const page = await source.getSelection(document, { ...filter, ...(cursor ? { cursor } : {}), limit: 128 }, signal);
      if (page.generationId !== document.generationId || page.revision !== document.revision) throw new Error("맵이 변경되었습니다. 다시 선택해주세요.");
      page.ids.forEach(id => ids.add(id));
      if (ids.size > 2000) throw new Error("대량 선택의 원자적 편집 연결이 준비 중입니다. 선택을 나누어 편집해주세요.");
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("선택 목록을 끝까지 불러오지 못했습니다.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  const values = new Map<string, MapElement>();
  const allIds = [...ids];
  for (let start = 0; start < allIds.length; start += 128) {
    signal.throwIfAborted();
    const elements = await source.getElements(document, allIds.slice(start, start + 128), signal);
    elements.forEach(element => values.set(element.id, element));
  }
  const selectedGroups = new Set(selection.groupIds);
  const explicit = new Set(selection.elementIds);
  for (const operation of operations) {
    if (operation.kind === "delete") values.delete(operation.id);
    if (operation.kind !== "add" && operation.kind !== "update") continue;
    const element = operation.element;
    const range = input.filter?.bounds;
    const bounds = range ? getMapElementBounds(element) : null;
    const matches = range && bounds ? bounds.minX <= range.maxX && bounds.maxX >= range.minX && bounds.minY <= range.maxY && bounds.maxY >= range.minY
      : input.filter?.layerId ? element.layerId === input.filter.layerId
      : explicit.has(element.id) || mapGroupContains(element.groupId, selectedGroups, groups);
    if (matches) values.set(element.id, element);
    else values.delete(element.id);
  }
  signal.throwIfAborted();
  if (values.size > 2000 || new TextEncoder().encode(JSON.stringify([...values.values()])).byteLength > 8 * 1024 * 1024) {
    throw new Error("대량 선택의 원자적 편집 연결이 준비 중입니다. 선택을 나누어 편집해주세요.");
  }
  return [...values.values()];
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
