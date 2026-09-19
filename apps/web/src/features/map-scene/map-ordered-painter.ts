import { mapDisplayPathPointCount } from "@led-control/shared/map-display-contracts";
import type { MapPaintRecord } from "./map-ordered-pages";
import { appendDisplayFillPrimitive, paintDisplayPrimitive } from "./map-native-painter";

export class MapOrderedPainter {
  private group: { id: string; elementId: string; color: string; opacity: number; points: number } | null = null;

  constructor(private readonly context: CanvasRenderingContext2D, private readonly zoom: number,
    private readonly reservePath: (bytes: number) => void) {}

  paint({ primitive, paintGroup }: MapPaintRecord): void {
    const ctx = this.context;
    if (!paintGroup) {
      this.finish();
      this.reservePath(mapDisplayPathPointCount(primitive) * 64 + 512);
      try { paintDisplayPrimitive(ctx, primitive, this.zoom); }
      finally { ctx.beginPath(); this.reservePath(0); }
      return;
    }
    if (primitive.elementId !== paintGroup.elementId || primitive.style.fillColor === null ||
        primitive.style.fillColor !== paintGroup.style.fillColor || primitive.style.opacity !== paintGroup.style.opacity ||
        primitive.style.strokeColor !== null || !(primitive.type === "triangle" || primitive.type === "polyline" && primitive.geometry.closed)) {
      throw new Error("Invalid semantic fill continuation");
    }
    if (this.group?.id !== paintGroup.id) this.finish();
    const current = this.group;
    if (current && (current.elementId !== primitive.elementId || current.color !== primitive.style.fillColor ||
        current.opacity !== primitive.style.opacity)) throw new Error("Conflicting semantic fill continuation");
    const points = (current?.points ?? 0) + mapDisplayPathPointCount(primitive);
    // Include native path nodes and temporary contour references. Never flush
    // an incomplete union to save memory: doing so changes alpha at its edges.
    this.reservePath(points * 64);
    if (!current) {
      ctx.save(); ctx.beginPath();
      ctx.globalAlpha = primitive.style.opacity; ctx.fillStyle = primitive.style.fillColor;
      this.group = { id: paintGroup.id, elementId: primitive.elementId,
        color: primitive.style.fillColor, opacity: primitive.style.opacity, points };
    } else current.points = points;
    appendDisplayFillPrimitive(ctx, primitive);
  }

  finish(): void {
    if (this.group) { this.context.fill("nonzero"); this.context.restore(); this.context.beginPath(); this.group = null; }
    this.reservePath(0);
  }

  cancel(): void {
    if (this.group) { this.context.restore(); this.context.beginPath(); this.group = null; }
    this.reservePath(0);
  }
}
