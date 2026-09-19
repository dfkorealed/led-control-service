import type { OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import type { MapElement, Point } from "@led-control/shared/map-document-contracts";
import { mapElementPaths } from "./map-scene-geometry";

type Context = CanvasRenderingContext2D;

function ring(ctx: Context, points: readonly Point[], closed: boolean): void {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  if (closed) ctx.closePath();
}

function fillContours(points: readonly Point[]): readonly (readonly Point[])[] {
  const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
  const contours: (readonly Point[])[] = [];
  let start = 0;
  while (start < points.length) {
    let end = start + 1;
    while (end < points.length && !same(points[start], points[end])) end++;
    if (end === points.length || end - start < 3) return [points];
    contours.push(points.slice(start, end));
    if (start > 0) {
      if (end + 1 >= points.length || !same(points[end + 1], points[0])) return [points];
      end++;
    }
    start = end + 1;
  }
  return contours;
}

function paint(ctx: Context, style: MapElement["style"], closed: boolean, zoom: number, holes = false): void {
  ctx.globalAlpha = style.opacity;
  if (closed && style.fillColor) { ctx.fillStyle = style.fillColor; ctx.fill(holes ? "evenodd" : "nonzero"); }
  if (style.strokeColor && style.strokeWidth > 0) {
    ctx.strokeStyle = style.strokeColor; ctx.lineWidth = Math.max(style.strokeWidth, 0.5 / zoom); ctx.stroke();
  }
}

function text(ctx: Context, value: string, width: number, height: number, color: string | null): void {
  if (!color || !value || width <= 0 || height <= 0) return;
  ctx.font = "32px sans-serif"; ctx.textBaseline = "top"; ctx.fillStyle = color;
  const measured = Math.max(1, ctx.measureText(value).width);
  ctx.scale(width / (Math.ceil(measured) + 4), height / 36);
  ctx.fillText(value, 2, 2);
}

export function canJoinDisplayFill(a: OrderedMapDisplayPrimitive, b: OrderedMapDisplayPrimitive): boolean {
  // The canonical producer triangulates these closed shapes into disjoint
  // fill fragments. One path avoids antialias seams at their internal edges;
  // arbitrary CAD triangles and differently styled fragments stay independent.
  return a.type === "triangle" && b.type === "triangle" &&
    ["rectangle", "triangle", "polygon", "ellipse", "HATCH"].includes(a.sourceType) && a.sourceType === b.sourceType &&
    a.elementId === b.elementId && a.layerName === b.layerName && a.zIndex === b.zIndex &&
    a.style.strokeColor === null && b.style.strokeColor === null &&
    a.style.fillColor === b.style.fillColor && a.style.opacity === b.style.opacity;
}

export function paintDisplayFillRun(ctx: Context, primitives: readonly OrderedMapDisplayPrimitive[], order: Uint32Array): void {
  ctx.save(); ctx.beginPath();
  for (const index of order) {
    const p = primitives[index];
    if (p.type !== "triangle") throw new Error("Invalid canonical fill run");
    appendDisplayFillPrimitive(ctx, p);
  }
  const style = primitives[order[0]].style;
  ctx.globalAlpha = style.opacity;
  if (style.fillColor) { ctx.fillStyle = style.fillColor; ctx.fill(); }
  ctx.restore();
}

export function appendDisplayFillPrimitive(ctx: Context, primitive: OrderedMapDisplayPrimitive): void {
  if (primitive.type === "triangle") {
    const [a, b, c] = primitive.geometry.points;
    // Normalize tessellation winding; shared edges cancel without alpha seams.
    const positive = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) >= 0;
    ring(ctx, positive ? [a, b, c] : [a, c, b], true);
  } else if (primitive.type === "polyline" && primitive.geometry.closed) {
    for (const contour of fillContours(primitive.geometry.points)) ring(ctx, contour, true);
  } else throw new Error("Invalid semantic fill primitive");
}

/** The cell canvas is the sole raster clip. Reapplying per-part clipBounds
 * would antialias a shared boundary twice and change translucent coverage. */
export function paintDisplayPrimitive(ctx: Context, p: OrderedMapDisplayPrimitive, zoom: number): void {
  ctx.save(); ctx.beginPath();
  let closed = true;
  switch (p.type) {
    case "line": ring(ctx, [p.geometry.start, p.geometry.end], false); closed = false; break;
    case "polyline": {
      // The v2 compound contour walks each connector in both directions.
      // Canvas antialiases those zero-area edges unless we lift the pen between
      // complete contours. Preserve their original nonzero winding and never
      // apply this interpretation to stroke paths or unrecognized sequences.
      const contours = p.geometry.closed && p.style.fillColor && p.style.strokeColor === null
        ? fillContours(p.geometry.points) : [p.geometry.points];
      for (const contour of contours) ring(ctx, contour, p.geometry.closed);
      closed = p.geometry.closed; break;
    }
    case "triangle": ring(ctx, p.geometry.points, true); break;
    case "rectangle": {
      const g = p.geometry; ctx.translate(g.origin.x, g.origin.y); ctx.rotate(g.rotation * Math.PI / 180);
      ctx.globalAlpha = p.style.opacity;
      if (p.style.fillColor) { ctx.fillStyle = p.style.fillColor; ctx.fillRect(0, 0, g.width, g.height); }
      if (p.style.strokeColor && p.style.strokeWidth > 0) {
        ctx.strokeStyle = p.style.strokeColor; ctx.lineWidth = Math.max(p.style.strokeWidth, 0.5 / zoom); ctx.strokeRect(0, 0, g.width, g.height);
      }
      ctx.restore(); return;
    }
    case "ellipse": {
      const g = p.geometry; ctx.ellipse(g.center.x, g.center.y, g.radiusX, g.radiusY, g.rotation * Math.PI / 180, 0, Math.PI * 2); break;
    }
    case "arc": {
      const g = p.geometry; const norm = (n: number) => ((n % 360) + 360) % 360;
      const start = norm(g.startAngle), positive = norm(g.endAngle - start) || 360;
      const sweep = g.counterClockwise ? positive : -(360 - positive || 360);
      ctx.arc(g.center.x, g.center.y, g.radius, start * Math.PI / 180, (start + sweep) * Math.PI / 180, !g.counterClockwise);
      closed = false; break;
    }
    case "text": {
      const g = p.geometry; ctx.globalAlpha = p.style.opacity; ctx.translate(g.position.x, g.position.y);
      ctx.rotate(g.rotation * Math.PI / 180); ctx.translate(0, -g.height);
      text(ctx, g.text, g.width, g.height, p.style.strokeColor ?? p.style.fillColor); ctx.restore(); return;
    }
  }
  paint(ctx, p.style, closed, zoom); ctx.restore();
}

export function paintMapElement(ctx: Context, element: MapElement, zoom: number): void {
  ctx.save(); ctx.beginPath();
  if (element.type === "text") {
    const t = element.transform, g = element.geometry;
    ctx.globalAlpha = element.style.opacity; ctx.translate(t.x, t.y); ctx.rotate(t.rotation * Math.PI / 180);
    ctx.scale(t.scaleX, t.scaleY); ctx.translate(g.position.x, g.position.y);
    text(ctx, g.text, g.width, g.height, element.style.strokeColor ?? element.style.fillColor);
  } else {
    const path = mapElementPaths(element, zoom);
    for (const points of path.rings) ring(ctx, points, path.closed);
    paint(ctx, element.style, path.closed, zoom, path.rings.length > 1);
  }
  ctx.restore();
}
