import { describe, expect, it } from "vitest";
import { resolveMarkerHit } from "./marker-hit";

const targets = [
  { id: "center", left: 76, top: 76, width: 48, height: 48 },
  { id: "right", left: 83, top: 76, width: 48, height: 48 },
  { id: "bottom-disabled", left: 76, top: 83, width: 48, height: 48 }
];
describe("current marker hit geometry", () => {
  it("uses exact dot centers instead of selected/hovered/disabled stacking or array order", () => {
    expect(resolveMarkerHit({ x: 100, y: 100 }, targets)).toBe("center");
    expect(resolveMarkerHit({ x: 107, y: 100 }, [...targets].reverse())).toBe("right");
    expect(resolveMarkerHit({ x: 100, y: 107 }, targets)).toBe("bottom-disabled");
  });
  it("keeps the real 48px padding usable and prefers a neighbouring actual dot", () => {
    expect(resolveMarkerHit({ x: 77, y: 77 }, targets)).toBe("center");
    expect(resolveMarkerHit({ x: 108, y: 100 }, targets)).toBe("right");
    expect(resolveMarkerHit({ x: 132, y: 100 }, targets)).toBeNull();
  });
  it("uses stable IDs for equal centers without promoting eligible neighbours", () => {
    const same = [targets[0], { ...targets[0], id: "a-disabled" }];
    expect(resolveMarkerHit({ x: 100, y: 100 }, same)).toBe("a-disabled");
    expect(resolveMarkerHit({ x: 100, y: 100 }, [...same].reverse())).toBe("a-disabled");
  });
  it("rejects missing or non-finite live geometry", () => {
    expect(resolveMarkerHit({ x: NaN, y: 100 }, targets)).toBeNull();
    expect(resolveMarkerHit({ x: 100, y: 100 }, [{ ...targets[0], width: 0 }])).toBeNull();
  });
});
