import { BadRequestException, ConflictException } from "@nestjs/common";
import { Bounds, MapDocumentRef, MapDocumentState, MapOp, getMapElementBounds,
  MAP_DOCUMENT_MAX_SELECTED_ELEMENTS, validateMapOperations } from "@led-control/shared";

/** state contains touched originals and (for structural deletion) every affected
 * member, never an all-document geometry clone. Structure metadata is bounded. */
export function planMapChanges(ref: Pick<MapDocumentRef, "width" | "height" | "elementCount">,
  state: MapDocumentState, operations: MapOp[]) {
  if (operations.length) {
    try { validateMapOperations(state, operations); }
    catch (error) { throw new BadRequestException((error as Error).message); }
  }
  const elements = new Map(state.elements.map(e => [e.id, e]));
  const groups = new Map(state.groups.map(g => [g.id, g]));
  const layers = new Map(state.layers.map(l => [l.id, l]));
  const finalGroups = new Map(groups), finalLayers = new Map(layers);
  for (const op of operations) {
    if (op.kind === "group.put") finalGroups.set(op.group.id, op.group);
    if (op.kind === "layer.put") finalLayers.set(op.layer.id, op.layer);
  }
  const groupLocked = (id: string | null, table = groups): boolean => {
    const seen = new Set<string>();
    while (id !== null) {
      if (seen.has(id)) throw new BadRequestException("group cycle");
      seen.add(id);
      const group = table.get(id);
      if (!group) throw new BadRequestException("missing group");
      if (group.locked) return true;
      id = group.parentId;
    }
    return false;
  };
  const inverse: MapOp[] = [], changedBounds: Bounds[] = [];
  let elementCount = ref.elementCount;
  const locked = () => { throw new ConflictException("map target is locked"); };
  const unlockOnly = (before: { locked: boolean }, after: { locked: boolean }) => before.locked && !after.locked &&
    JSON.stringify({ ...before, locked: false }) === JSON.stringify(after);
  for (const op of operations) {
    if (op.kind === "add" || op.kind === "update" || op.kind === "delete") {
      const before = elements.get(op.kind === "delete" ? op.id : op.element.id);
      const after = op.kind === "delete" ? undefined : op.element;
      if (before) {
        if (groupLocked(before.groupId) || layers.get(before.layerId)?.locked ||
          (before.locked && !(after && unlockOnly(before, after)))) locked();
        changedBounds.push(getMapElementBounds(before));
      }
      if (after) {
        if (groupLocked(after.groupId, finalGroups) || finalLayers.get(after.layerId)?.locked) locked();
        const bounds = getMapElementBounds(after);
        if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > ref.width || bounds.maxY > ref.height) {
          throw new BadRequestException("map element exceeds floor bounds");
        }
        changedBounds.push(bounds);
      }
      if (op.kind === "add") { inverse.unshift({ kind: "delete", id: op.element.id }); elementCount++; }
      else if (op.kind === "update") inverse.unshift({ kind: "update", element: before! });
      else { inverse.unshift({ kind: "add", element: before! }); elementCount--; }
    } else if (op.kind === "group.put" || op.kind === "group.delete") {
      const before = groups.get(op.kind === "group.put" ? op.group.id : op.id);
      if (before && (groupLocked(before.parentId) || (before.locked && !(op.kind === "group.put" && unlockOnly(before, op.group))))) locked();
      if (op.kind === "group.put" && groupLocked(op.group.parentId, finalGroups)) locked();
      inverse.unshift(before ? { kind: "group.put", group: before } : { kind: "group.delete", id: (op as Extract<MapOp, { kind: "group.put" }>).group.id });
    } else {
      const before = layers.get(op.kind === "layer.put" ? op.layer.id : op.id);
      if (before?.locked && !(op.kind === "layer.put" && unlockOnly(before, op.layer))) locked();
      inverse.unshift(before ? { kind: "layer.put", layer: before } : { kind: "layer.delete", id: (op as Extract<MapOp, { kind: "layer.put" }>).layer.id });
    }
  }
  if (elementCount < 0 || elementCount > MAP_DOCUMENT_MAX_SELECTED_ELEMENTS) throw new BadRequestException("map element count exceeds limit");
  return { operations, inverse, changedBounds, elementCount };
}
