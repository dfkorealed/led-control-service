import type { Bounds, MapElement, Point } from "./map-document-contracts.js";

export const MAP_POLYGON_MAX_VALIDATION_STEPS = 1_000_000;
const radians = (degrees: number) => (degrees % 360) * Math.PI / 180;
const positiveAngle = (degrees: number) => ((degrees % 360) + 360) % 360;

/** Local geometry is scaled about (0, 0), rotated in degrees, then translated. */
export function transformMapPoint(point: Point, transform: MapElement["transform"]): Point {
  const angle = radians(transform.rotation);
  const x = point.x * transform.scaleX;
  const y = point.y * transform.scaleY;
  const result = {
    x: x * Math.cos(angle) - y * Math.sin(angle) + transform.x,
    y: x * Math.sin(angle) + y * Math.cos(angle) + transform.y
  };
  if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) {
    throw new RangeError("변환 좌표는 유한값이어야 합니다.");
  }
  return result;
}

/** Geometry-only AABB. Renderers must account for their own stroke caps/joins. */
export function getMapElementBounds(element: MapElement): Bounds {
  const { transform } = element;
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (point: Point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RangeError("도형 경계는 유한값이어야 합니다.");
    }
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  };
  const local = (point: Point) => include(transformMapPoint(point, transform));
  const box = (origin: Point, width: number, height: number) => {
    local(origin);
    local({ x: origin.x + width, y: origin.y });
    local({ x: origin.x, y: origin.y + height });
    local({ x: origin.x + width, y: origin.y + height });
  };
  switch (element.type) {
    case "line": local(element.geometry.start); local(element.geometry.end); break;
    case "rectangle": box(element.geometry.origin, element.geometry.width, element.geometry.height); break;
    case "text": box(element.geometry.position, element.geometry.width, element.geometry.height); break;
    case "triangle":
    case "polyline": element.geometry.points.forEach(local); break;
    case "polygon": element.geometry.outer.forEach(local); break;
    case "ellipse":
    case "arc": {
      const geometry = element.geometry;
      const center = transformMapPoint(geometry.center, transform);
      const rx = (element.type === "ellipse" ? element.geometry.radiusX : element.geometry.radius) * transform.scaleX;
      const ry = (element.type === "ellipse" ? element.geometry.radiusY : element.geometry.radius) * transform.scaleY;
      const angle = radians(transform.rotation);
      // Each world axis is A*cos(t) + B*sin(t); derivative roots give exact
      // extrema even after a nonuniform scale followed by rotation.
      const a = rx * Math.cos(angle), b = -ry * Math.sin(angle);
      const c = rx * Math.sin(angle), d = ry * Math.cos(angle);
      const at = (degrees: number) => {
        const t = radians(degrees);
        include({ x: center.x + a * Math.cos(t) + b * Math.sin(t),
          y: center.y + c * Math.cos(t) + d * Math.sin(t) });
      };
      if (element.type === "ellipse") {
        const extentX = Math.hypot(a, b), extentY = Math.hypot(c, d);
        include({ x: center.x - extentX, y: center.y - extentY });
        include({ x: center.x + extentX, y: center.y + extentY });
      } else {
        const { startAngle, endAngle, counterClockwise } = element.geometry;
        const start = positiveAngle(startAngle), end = positiveAngle(endAngle);
        // Match existing CAD semantics: equal normalized endpoints mean a full
        // circle; counterClockwise advances the numeric angle in logical space.
        const sweep = (counterClockwise ? positiveAngle(end - start) : positiveAngle(start - end)) || 360;
        at(start); at(end);
        const roots = [Math.atan2(b, a), Math.atan2(d, c)].map((t) => t * 180 / Math.PI);
        for (const candidate of roots.flatMap((root) => [root, root + 180])) {
          const distance = counterClockwise ? positiveAngle(candidate - start) : positiveAngle(start - candidate);
          if (distance <= sweep) at(candidate);
        }
      }
      break;
    }
  }
  if (!Object.values(bounds).every(Number.isFinite) ||
      !Number.isFinite(bounds.maxX - bounds.minX) || !Number.isFinite(bounds.maxY - bounds.minY)) {
    throw new RangeError("도형 경계와 길이는 유한값이어야 합니다.");
  }
  return bounds;
}

type Segment = { a: Point; b: Point; ring: number; index: number; minX: number; maxX: number; minY: number; maxY: number };
function orientation(a: Point, b: Point, c: Point): number {
  const left = (b.x - a.x) * (c.y - a.y);
  const right = (b.y - a.y) * (c.x - a.x);
  const value = left - right;
  // Near-collinear floating-point inputs are treated conservatively as touching,
  // never as proof that two boundaries are disjoint.
  return Math.abs(value) <= (Math.abs(left) + Math.abs(right)) * Number.EPSILON * 8 ? 0 : Math.sign(value);
}
function onSegment(a: Point, b: Point, p: Point): boolean {
  return orientation(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
function intersects(left: Segment, right: Segment): boolean {
  const { a, b } = left, { a: c, b: d } = right;
  const abc = orientation(a, b, c), abd = orientation(a, b, d);
  const cda = orientation(c, d, a), cdb = orientation(c, d, b);
  return (abc * abd < 0 && cda * cdb < 0) ||
    (abc === 0 && onSegment(a, b, c)) || (abd === 0 && onSegment(a, b, d)) ||
    (cda === 0 && onSegment(c, d, a)) || (cdb === 0 && onSegment(c, d, b));
}

/** Rings use implicit closure, either winding, and strictly disjoint holes. */
export function getMapPolygonValidationError(outer: Point[], holes: Point[][]): string | null {
  let remaining = MAP_POLYGON_MAX_VALIDATION_STEPS;
  const spend = () => {
    if (--remaining < 0) throw new RangeError("다각형 검증 연산 한도를 초과했습니다.");
  };
  try {
    const input = [outer, ...holes];
    const all = input.flat();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of all) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return "다각형 좌표는 유한값이어야 합니다.";
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const scale = Math.max(maxX - minX, maxY - minY);
    if (!Number.isFinite(scale) || scale <= 0) return "다각형 면적이 올바르지 않습니다.";
    // Normalize before products to avoid overflow/underflow for finite CAD units.
    const rings = input.map((ring) => ring.map((p) => ({ x: (p.x - minX) / scale, y: (p.y - minY) / scale })));
    const segments: Segment[] = [];
    for (const [ringId, ring] of rings.entries()) {
      if (ring.length < 3) return "링에는 서로 다른 꼭짓점이 3개 이상 필요합니다.";
      const seen = new Set<string>();
      let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const key = `${a.x},${a.y}`;
        if (seen.has(key)) return "링의 꼭짓점을 중복하거나 끝점을 반복할 수 없습니다.";
        seen.add(key);
        area += (a.x - ring[0].x) * (b.y - ring[0].y) - (a.y - ring[0].y) * (b.x - ring[0].x);
        const previous = ring[(i + ring.length - 1) % ring.length];
        if (orientation(previous, a, b) === 0 && (onSegment(previous, a, b) || onSegment(a, b, previous))) {
          return "인접한 링 경계가 겹칩니다.";
        }
        segments.push({ a, b, ring: ringId, index: i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
      }
      if (area === 0) return "링의 면적은 0일 수 없습니다.";
    }
    // Sweep broad-phase rejects disjoint x ranges. Every candidate (including
    // y-disjoint ones) spends a shared budget, bounding adversarial quadratic work.
    segments.sort((a, b) => a.minX - b.minX);
    for (let i = 0; i < segments.length; i++) {
      const a = segments[i];
      for (let j = i + 1; j < segments.length && segments[j].minX <= a.maxX; j++) {
        spend();
        const b = segments[j];
        if (a.maxY < b.minY || b.maxY < a.minY) continue;
        const adjacent = a.ring === b.ring && (Math.abs(a.index - b.index) === 1 ||
          Math.abs(a.index - b.index) === rings[a.ring].length - 1);
        if (!adjacent && intersects(a, b)) return "링 경계가 교차하거나 접촉합니다.";
      }
    }
    const contains = (ring: Point[], point: Point) => {
      let inside = false;
      for (let i = 0; i < ring.length; i++) {
        spend();
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if ((a.y > point.y) !== (b.y > point.y) &&
            point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    for (let i = 1; i < rings.length; i++) {
      if (!contains(rings[0], rings[i][0])) return "내부 링은 외부 링 안에 있어야 합니다.";
      for (let j = 1; j < i; j++) {
        if (contains(rings[j], rings[i][0]) || contains(rings[i], rings[j][0])) {
          return "내부 링을 중첩할 수 없습니다.";
        }
      }
    }
    return null;
  } catch (error) {
    if (error instanceof RangeError) return error.message;
    throw error;
  }
}
