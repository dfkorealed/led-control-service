export interface EditorSpatialBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorSpatialItem {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface EditorSpatialIndex<T extends EditorSpatialItem> {
  cellSize: number;
  buckets: Map<string, Array<{ item: T; order: number }>>;
}

export function buildEditorSpatialIndex<T extends EditorSpatialItem>(
  items: readonly T[],
  cellSize: number
): EditorSpatialIndex<T> {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("cellSize must be positive");
  const buckets = new Map<string, Array<{ item: T; order: number }>>();
  items.forEach((item, order) => {
    const width = Math.max(0, item.width ?? 0);
    const height = Math.max(0, item.height ?? 0);
    const minCellX = Math.floor(item.x / cellSize);
    const minCellY = Math.floor(item.y / cellSize);
    const maxCellX = Math.floor((item.x + width) / cellSize);
    const maxCellY = Math.floor((item.y + height) / cellSize);
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const key = `${cellX}:${cellY}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push({ item, order });
        else buckets.set(key, [{ item, order }]);
      }
    }
  });
  return { cellSize, buckets };
}

export function queryEditorSpatialIndex<T extends EditorSpatialItem>(
  index: EditorSpatialIndex<T>,
  bounds: EditorSpatialBounds,
  margin: number
): T[] {
  const safeMargin = Math.max(0, margin);
  const query = {
    x: bounds.x - safeMargin,
    y: bounds.y - safeMargin,
    width: bounds.width + safeMargin * 2,
    height: bounds.height + safeMargin * 2
  };
  const found = new Map<string, { item: T; order: number }>();
  const minCellX = Math.floor(query.x / index.cellSize);
  const minCellY = Math.floor(query.y / index.cellSize);
  const maxCellX = Math.floor((query.x + query.width) / index.cellSize);
  const maxCellY = Math.floor((query.y + query.height) / index.cellSize);
  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (const entry of index.buckets.get(`${cellX}:${cellY}`) ?? []) {
        if (found.has(entry.item.id) || !intersects(entry.item, query)) continue;
        found.set(entry.item.id, entry);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.order - b.order).map((entry) => entry.item);
}

function intersects(item: EditorSpatialItem, bounds: EditorSpatialBounds) {
  const right = item.x + Math.max(0, item.width ?? 0);
  const bottom = item.y + Math.max(0, item.height ?? 0);
  return right >= bounds.x && item.x <= bounds.x + bounds.width
    && bottom >= bounds.y && item.y <= bounds.y + bounds.height;
}
