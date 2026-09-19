import type { Bounds, MapElement, MapLayer } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import type { MapSelectionInput } from "../../api/map-document";
import { isMapSelectionLocked, mapGroupContains, type MapSelectionQuery } from "./map-editor-selection";

export const MAX_INLINE_SELECTION_ELEMENTS = 128;
export const MAX_INLINE_SELECTION_BYTES = 256 * 1024;
export interface MapSelectionStreamQuery extends MapSelectionQuery {
  filters?: readonly MapSelectionInput[];
  layers?: ReadonlyMap<string, MapLayer>;
}
export interface MapSelectionSummary {
  count: number;
  bounds: Bounds | null;
  /** Null means streamed, never a partial list of a larger selection. */
  inline: MapElement[] | null;
  locked: boolean;
}
export function unionMapBounds(a: Bounds | null, b: Bounds): Bounds {
  return a ? { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) } : { ...b };
}

/** One selection page and one canonical page are resident. Overlapping queries
 * are deduplicated by their predicates, not an ever-growing set of element IDs. */
export async function* streamMapSelection(input: MapSelectionStreamQuery): AsyncGenerator<MapElement> {
  const { document, source, signal, selection, groups } = input;
  const filters: readonly MapSelectionInput[] = input.filters ?? (input.filter ? [input.filter] : selection.groupIds.map(groupId => ({ groupId })));
  const changedGroups = input.operations.some(op => op.kind === "group.put" || op.kind === "group.delete");
  const explicit = new Set(selection.elementIds);
  const changed = new Map<string, MapElement | null>();
  for (const op of input.operations) {
    if (op.kind === "delete") changed.set(op.id, null);
    else if (op.kind === "add" || op.kind === "update") changed.set(op.element.id, op.element);
  }
  const predicates = filters.map(filter => {
    const selectedGroups = new Set(filter.groupId ? [filter.groupId] : []);
    return (element: MapElement) => {
      if (filter.groupId && !mapGroupContains(element.groupId, selectedGroups, groups)) return false;
      if (filter.layerId && element.layerId !== filter.layerId) return false;
      if (filter.bounds) {
        const b = getMapElementBounds(element), range = filter.bounds;
        if (b.minX > range.maxX || b.maxX < range.minX || b.minY > range.maxY || b.maxY < range.minY) return false;
      }
      return true;
    };
  });
  const explicitIds = [...explicit];
  for (let start = 0; start < explicitIds.length; start += 128) {
    signal.throwIfAborted();
    const elements = await source.getElements(document, explicitIds.slice(start, start + 128), signal);
    signal.throwIfAborted();
    for (const element of elements) if (!changed.has(element.id)) yield element;
  }
  for (const [index, filter] of filters.entries()) {
    let cursor: string | undefined, checkpoint: string | undefined, power = 1, distance = 0;
    do {
      signal.throwIfAborted();
      // A local reparent can bring a subtree into a group the persisted query
      // does not yet know about. Stream the broader source, then apply current ancestry.
      const page = await source.getSelection(document, { ...filter, ...(changedGroups && filter.groupId ? { groupId: undefined } : {}), cursor, limit: 128 }, signal);
      signal.throwIfAborted();
      if (page.generationId !== document.generationId || page.revision !== document.revision) throw new Error("맵이 변경되었습니다. 다시 선택해주세요.");
      if (page.ids.length) {
        const elements = await source.getElements(document, page.ids, signal);
        signal.throwIfAborted();
        for (const element of elements) {
          if (changed.has(element.id) || explicit.has(element.id) || !predicates[index](element)) continue;
          if (!predicates.slice(0, index).some(matches => matches(element))) yield element;
        }
      }
      const next = page.nextCursor ?? undefined;
      // Brent cycle detection keeps cursor bookkeeping constant-space too.
      if (next && (next === cursor || next === checkpoint)) throw new Error("선택 목록을 끝까지 불러오지 못했습니다.");
      if (++distance === power) { checkpoint = next; power *= 2; distance = 0; }
      cursor = next;
    } while (cursor);
  }
  for (const element of changed.values()) {
    signal.throwIfAborted();
    if (element && (explicit.has(element.id) || predicates.some(matches => matches(element)))) yield element;
  }
}

/** Complete summary first: large operations must never act on a loaded prefix. */
export async function inspectMapSelection(input: MapSelectionStreamQuery): Promise<MapSelectionSummary> {
  const result: MapSelectionSummary = { count: 0, bounds: null, inline: [], locked: false };
  let bytes = 0;
  const encoder = new TextEncoder();
  for await (const element of streamMapSelection(input)) {
    result.count++;
    result.bounds = unionMapBounds(result.bounds, getMapElementBounds(element));
    result.locked ||= input.layers ? isMapSelectionLocked([element], input.groups, input.layers) : element.locked;
    if (result.inline) {
      bytes += encoder.encode(JSON.stringify(element)).byteLength;
      if (result.count > MAX_INLINE_SELECTION_ELEMENTS || bytes > MAX_INLINE_SELECTION_BYTES) result.inline = null;
      else result.inline.push(element);
    }
  }
  return result;
}
