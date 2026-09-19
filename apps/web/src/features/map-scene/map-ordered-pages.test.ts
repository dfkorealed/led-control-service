import { describe, expect, it } from "vitest";
import type { MapDisplayFragmentKey, OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import { mergeMapPaintStreams, type MapPaintCursor } from "./map-ordered-pages";

const primitive = (id: string, zIndex: number): OrderedMapDisplayPrimitive => ({
  type: "line", elementId: id, zIndex, fragmentOrder: 0, layerName: "layer", groupId: null, sourceType: "line",
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, clipBounds: null,
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 0.5 },
  geometry: { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }
});
function cursor(values: OrderedMapDisplayPrimitive[]): MapPaintCursor {
  let index = 0;
  return { get key(): MapDisplayFragmentKey | null { return values[index] ?? null; },
    async read() { return { primitive: values[index] }; }, async advance() { index++; } };
}
async function collect(cursors: MapPaintCursor[], limit = 1_048_576) {
  let peak = 0;
  const ids: string[] = [];
  for await (const record of mergeMapPaintStreams(cursors, { signal: new AbortController().signal,
    reserveHeads: bytes => { peak = Math.max(peak, bytes); if (bytes > limit) throw new Error("head budget"); } })) {
    ids.push(record.primitive.elementId);
  }
  return { ids, peak };
}

describe("bounded ordered influence merge", () => {
  it("merges streams and draft positions with ordinal IDs rather than locale order", async () => {
    const result = await collect([cursor([primitive("z", 0), primitive("a", 2)]),
      cursor([primitive("Z", 0), primitive("draft", 1)])]);
    expect(result.ids).toEqual(["Z", "z", "draft", "a"]);
    expect(result.peak).toBeLessThan(1024);
  });

  it("paints a replicated fragment once but preserves distinct clipped fragments", async () => {
    const first = primitive("shared", 0), next = { ...first, fragmentOrder: 1 };
    const copied = { ...first, bounds: { minX: 0, minY: 0, maxX: 9, maxY: 9 } };
    const result = await collect([cursor([first, next]), cursor([copied])]);
    expect(result.ids).toEqual(["shared", "shared"]);
  });

  it("rejects equal-key geometry conflicts instead of hiding or double-painting them", async () => {
    const first = primitive("shared", 0), conflict = { ...first, style: { ...first.style, opacity: 1 } };
    await expect(collect([cursor([first]), cursor([conflict])])).rejects.toThrow("fragment identity");
  });

  it("checks stream monotonicity and bounds metadata before loading geometry", async () => {
    await expect(collect([cursor([primitive("b", 2), primitive("a", 1)])])).rejects.toThrow("stream order");
    let read = false;
    const source = cursor([primitive("a", 0)]), original = source.read;
    source.read = async () => { read = true; return original(); };
    await expect(collect([source], 1)).rejects.toThrow("head budget");
    expect(read).toBe(false);
  });

  it("bounds retained merge metadata by active streams, not primitive count", async () => {
    const generated = (parity: number): MapPaintCursor => {
      let index = parity;
      return { get key() { return index < 10000 ? { elementId: String(index), zIndex: index, fragmentOrder: 0 } : null; },
        async read() { return { primitive: primitive(String(index), index) }; }, async advance() { index += 2; } };
    };
    const result = await collect([generated(0), generated(1)]);
    expect(result.ids).toHaveLength(10000);
    expect(result.peak).toBeLessThan(1024);
  });
});
