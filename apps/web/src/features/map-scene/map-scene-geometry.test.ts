import type { MapElement } from "@led-control/shared/map-document-contracts";
import { describe, expect, it } from "vitest";
import { buildMapGeometryBatches, hitMapElement } from "./map-scene-geometry";

export const element = (id = "manual"): MapElement => ({
  id, type: "rectangle", geometry: { origin: { x: 10, y: 10 }, width: 20, height: 20 },
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  style: { strokeColor: "#ffffff", fillColor: "#00ff00", strokeWidth: 1, opacity: 1 },
  groupId: null, layerId: "walls", zIndex: 0, visible: true, locked: false, provenance: null
});

describe("common map geometry", () => {
  it("batches manual and imported shapes together without mutating canonical geometry", () => {
    const manual = element();
    const imported = { ...element("imported"), provenance: { importJobId: "job", sourceId: "source" } };
    const before = JSON.stringify([manual, imported]);
    const batch = buildMapGeometryBatches([manual, imported], 1);
    expect(batch.batches).toHaveLength(2);
    expect(batch.batches[0].spans.map(span => span.elementId)).toEqual(["manual", "imported"]);
    expect(JSON.stringify([manual, imported])).toBe(before);
  });

  it("triangulates holes and excludes their interiors from picking", () => {
    const polygon: MapElement = { ...element(), type: "polygon", style: { ...element().style, strokeColor: null },
      geometry: { outer: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
        holes: [[{ x: 20, y: 20 }, { x: 20, y: 80 }, { x: 80, y: 80 }, { x: 80, y: 20 }]] } };
    const batch = buildMapGeometryBatches([polygon], 1).batches[0];
    let area = 0;
    for (let i = 0; i < batch.indices.length; i += 3) {
      const [a, b, c] = [...batch.indices.slice(i, i + 3)].map(index => index * 2);
      const p = batch.positions;
      area += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
    }
    expect(area).toBe(6400);
    expect(hitMapElement(polygon, { x: 50, y: 50 }, 0)).toBe(false);
    expect(hitMapElement(polygon, { x: 10, y: 10 }, 0)).toBe(true);
  });

  it("uses the canonical top-left text anchor and applies nonuniform transforms once", () => {
    const text: MapElement = { ...element(), type: "text",
      transform: { x: 100, y: 200, scaleX: 2, scaleY: 3, rotation: 90 },
      geometry: { position: { x: 10, y: 20 }, width: 30, height: 10, fontSize: 10, text: "조명" } };
    const entry = buildMapGeometryBatches([text], 1).textBatches[0].entries[0];
    expect(entry.position.x).toBeCloseTo(10);
    expect(entry.position.y).toBeCloseTo(220);
    expect(entry.width).toBe(60);
    expect(entry.height).toBe(30);
    expect(hitMapElement(text, { x: 20, y: 240 }, 0)).toBe(true);
  });

  it("supports every shape and keeps open arcs unfilled", () => {
    const shapes: MapElement[] = [element(),
      { ...element("line"), type: "line", geometry: { start: { x: 0, y: 0 }, end: { x: 20, y: 20 } } },
      { ...element("triangle"), type: "triangle", geometry: { points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }] } },
      { ...element("ellipse"), type: "ellipse", geometry: { center: { x: 10, y: 10 }, radiusX: 10, radiusY: 5 } },
      { ...element("arc"), type: "arc", geometry: { center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: 90, counterClockwise: true } },
      { ...element("polyline"), type: "polyline", geometry: { points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] } }
    ];
    for (const shape of shapes) expect(buildMapGeometryBatches([shape], 2).batches.length).toBeGreaterThan(0);
    expect(hitMapElement(shapes[4], { x: 0, y: 0 }, 0)).toBe(false);
  });

  it("does not create a second unbounded pick grid for local drafts", () => {
    const large: MapElement = { ...element(), type: "rectangle", geometry: { origin: { x: 0, y: 0 }, width: 2048, height: 2048 } };
    const batch = buildMapGeometryBatches([large], 1);
    expect(batch.spatialIndex.buckets).toEqual({});
    expect(batch.pickEntries).toEqual([]);
    expect(hitMapElement(large, { x: 1024, y: 1024 }, 0)).toBe(true);
  });
});
