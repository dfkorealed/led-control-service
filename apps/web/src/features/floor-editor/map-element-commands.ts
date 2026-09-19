import type { MapElement, MapElementOp } from "@led-control/shared";

export class MapElementIdentityError extends Error {
  constructor(
    readonly code: "MAP_ELEMENT_EXISTS" | "MAP_ELEMENT_MISSING",
    readonly elementId: string
  ) {
    super(code === "MAP_ELEMENT_EXISTS" ? "Map element already exists" : "Map element is missing");
    this.name = "MapElementIdentityError";
  }
}

/**
 * Applies already-validated commands to the loaded affected subset, not a whole
 * document. Untouched canonical elements are shared and must remain immutable.
 * This is not an authorization/geometry/lock check: those remain U6 server duties.
 */
export function applyMapOps(
  elements: ReadonlyMap<string, MapElement>, operations: MapElementOp[]
): { elements: ReadonlyMap<string, MapElement>; inverse: MapElementOp[] } {
  if (operations.length === 0) return { elements, inverse: [] };

  const next = new Map(elements);
  const inverse: MapElementOp[] = [];
  for (const operation of operations) {
    const id = operation.kind === "delete" ? operation.id : operation.element.id;
    if (operation.kind === "add") {
      if (next.has(id)) throw new MapElementIdentityError("MAP_ELEMENT_EXISTS", id);
      next.set(id, structuredClone(operation.element));
      inverse.push({ kind: "delete", id });
      continue;
    }

    const before = next.get(id);
    if (!before) throw new MapElementIdentityError("MAP_ELEMENT_MISSING", id);
    inverse.push({
      kind: operation.kind === "delete" ? "add" : "update", element: structuredClone(before)
    });
    if (operation.kind === "delete") next.delete(id);
    else next.set(id, structuredClone(operation.element));
  }
  // Reverse once instead of repeatedly shifting a potentially large batch.
  return { elements: next, inverse: inverse.reverse() };
}
