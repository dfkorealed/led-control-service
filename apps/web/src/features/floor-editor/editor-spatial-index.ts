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
  oversized: Array<{ item: T; order: number }>;
  entries: Array<{ item: T; order: number }>;
}

const MAX_ITEM_CELL_COVERAGE = 256;
const MAX_QUERY_CELL_COVERAGE = 4_096;

export function buildEditorSpatialIndex<T extends EditorSpatialItem>(
  items: readonly T[],
  cellSize: number
): EditorSpatialIndex<T> {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error("cellSize must be positive");
  const buckets = new Map<string, Array<{ item: T; order: number }>>();
  const oversized: Array<{ item: T; order: number }> = [];
  const entries: Array<{ item: T; order: number }> = [];
  items.forEach((item, order) => {
    const width = item.width ?? 0;
    const height = item.height ?? 0;
    if (![item.x, item.y, width, height].every(Number.isFinite) || width < 0 || height < 0) return;
    const entry = { item, order };
    entries.push(entry);
    const minCellX = Math.floor(item.x / cellSize);
    const minCellY = Math.floor(item.y / cellSize);
    const maxCellX = Math.floor((item.x + width) / cellSize);
    const maxCellY = Math.floor((item.y + height) / cellSize);
    const coverage = (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1);
    if (coverage > MAX_ITEM_CELL_COVERAGE) {
      oversized.push(entry);
      return;
    }
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const key = `${cellX}:${cellY}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(entry);
        else buckets.set(key, [entry]);
      }
    }
  });
  return { cellSize, buckets, oversized, entries };
}

export function queryEditorSpatialIndex<T extends EditorSpatialItem>(
  index: EditorSpatialIndex<T>,
  bounds: EditorSpatialBounds,
  margin: number
): T[] {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width < 0 || bounds.height < 0) throw new Error("bounds must be finite and nonnegative");
  if (!Number.isFinite(margin)) throw new Error("margin must be finite and nonnegative");
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
  const coverage = (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1);
  if (coverage > MAX_QUERY_CELL_COVERAGE) {
    addIntersecting(index.entries, query, found);
  } else {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        addIntersecting(index.buckets.get(`${cellX}:${cellY}`) ?? [], query, found);
      }
    }
    addIntersecting(index.oversized, query, found);
  }
  return [...found.values()].sort((a, b) => a.order - b.order).map((entry) => entry.item);
}

function addIntersecting<T extends EditorSpatialItem>(
  entries: Array<{ item: T; order: number }>,
  bounds: EditorSpatialBounds,
  found: Map<string, { item: T; order: number }>
) {
  for (const entry of entries) {
    if (found.has(entry.item.id) || !intersects(entry.item, bounds)) continue;
    found.set(entry.item.id, entry);
  }
}

function intersects(item: EditorSpatialItem, bounds: EditorSpatialBounds) {
  const right = item.x + Math.max(0, item.width ?? 0);
  const bottom = item.y + Math.max(0, item.height ?? 0);
  return right >= bounds.x && item.x <= bounds.x + bounds.width
    && bottom >= bounds.y && item.y <= bounds.y + bounds.height;
}

export function mapObjectWorldAabb(object: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  strokeWidth: number;
  type: string;
}): EditorSpatialBounds {
  const radians = object.rotation * Math.PI / 180;
  const cosine = normalizedTrig(Math.cos(radians));
  const sine = normalizedTrig(Math.sin(radians));
  const points = [
    { x: 0, y: 0 },
    { x: object.width, y: 0 },
    { x: object.width, y: object.height },
    { x: 0, y: object.height }
  ].map((point) => ({
    x: object.x + point.x * cosine - point.y * sine,
    y: object.y + point.x * sine + point.y * cosine
  }));
  const strokeWidth = object.type === "line" ? Math.max(object.strokeWidth, 6) : object.strokeWidth;
  const padding = Math.max(0, strokeWidth) / 2;
  const left = Math.min(...points.map((point) => point.x)) - padding;
  const top = Math.min(...points.map((point) => point.y)) - padding;
  const right = Math.max(...points.map((point) => point.x)) + padding;
  const bottom = Math.max(...points.map((point) => point.y)) + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizedTrig(value: number) {
  if (Math.abs(value) < 1e-12) return 0;
  if (Math.abs(value - 1) < 1e-12) return 1;
  if (Math.abs(value + 1) < 1e-12) return -1;
  return value;
}
