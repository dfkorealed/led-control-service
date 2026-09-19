import { afterEach, expect, it, vi } from "vitest";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import { paintMapOrderedCell } from "./map-ordered-cell";
import { MapPaintWindow } from "./map-paint-window";
import * as geometry from "./map-scene-geometry";

afterEach(() => vi.restoreAllMocks());
const curve = (type: "ellipse" | "arc"): MapElement => ({
  id: "curve", groupId: null, layerId: "layer", zIndex: 0, visible: true, locked: false, provenance: null,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
  ...(type === "ellipse" ? { type, geometry: { center: { x: 8192, y: 8192 }, radiusX: 8000, radiusY: 8000 } }
    : { type, geometry: { center: { x: 8192, y: 8192 }, radius: 8000, startAngle: 0, endAngle: 360, counterClockwise: true } })
});
function setup(draft: MapElement, reserve: (key: string, bytes: number) => void, zoom = 100) {
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    closePath: vi.fn(), stroke: vi.fn(), fill: vi.fn() };
  const budget = new CadSceneMemoryBudget(32 * 1024 * 1024), signal = new AbortController().signal;
  const window = new MapPaintWindow({ budget, signal, layerId: name => name, load: vi.fn() });
  return { context, window, run: () => paintMapOrderedCell({ tiles: [], drafts: [draft],
    layers: new Map([["layer", { order: 0, visible: true }]]), context: context as unknown as CanvasRenderingContext2D,
    window, zoom, signal, excludedIds: new Set(), reserve }) };
}
it.each(["ellipse", "arc"] as const)("accounts every subdivided %s path point", async type => {
  let peak = 0;
  const { run, context, window } = setup(curve(type), (key, bytes) => { if (key === "path") peak = Math.max(peak, bytes); });
  try {
    await run();
    const points = context.moveTo.mock.calls.length + context.lineTo.mock.calls.length;
    expect(points).toBeGreaterThan(1024); expect(points).toBeLessThanOrEqual(4097);
    expect(peak).toBe(points * 64 + 1024);
  } finally { window.close(); }
});
it.each(["ellipse", "arc"] as const)("rejects %s path admission before allocating geometry", async type => {
  const paths = vi.spyOn(geometry, "mapElementPaths");
  const { run, context, window } = setup(curve(type), (key, bytes) => {
    if (key === "path" && bytes > 100_000) throw new Error("path budget");
  });
  try {
    await expect(run()).rejects.toThrow("path budget");
    expect(paths).not.toHaveBeenCalled(); expect(context.moveTo).not.toHaveBeenCalled();
  } finally { window.close(); }
});
