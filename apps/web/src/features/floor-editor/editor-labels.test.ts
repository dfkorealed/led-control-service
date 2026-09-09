import { describe, expect, it } from "vitest";
import { canShowFixtureNames, selectedFixtureLabelLayout } from "./editor-labels";
import type { EditorFixture } from "./editor-types";

const fixture: EditorFixture = { id: "f1", name: "L1", x: 20, y: 20, size: 20, ratedWatt: 40, brightness: 70, status: "online" };
describe("editor label density", () => {
  it.each([0.2, 0.5, 1, 2])("keeps the focused label screen-sized and inside the viewport at %sx", (zoom) => {
    const pan = { x: 200, y: -50 };
    const label = selectedFixtureLabelLayout({ ...fixture, x: 1200, y: 800 }, pan, zoom, { width: 320, height: 480 });
    expect(label.scaleX * zoom).toBeCloseTo(1);
    expect(label.scaleY * zoom).toBeCloseTo(1);
    const x = label.x * zoom + pan.x, y = label.y * zoom + pan.y;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + label.width).toBeLessThanOrEqual(320);
    expect(y + label.height).toBeLessThanOrEqual(480);
    expect(label.height).toBe(28);
  });
  it("hides bulk names in a dense 1000-fixture view even at 100% zoom", () => {
    const fixtures = Array.from({ length: 1000 }, (_, i) => ({ ...fixture, id: `f${i}`, x: 20 + i % 40 * 25, y: 20 + Math.floor(i / 40) * 25 }));
    expect(canShowFixtureNames(fixtures, 1)).toBe(false);
    expect(canShowFixtureNames(fixtures, 2)).toBe(false);
  });
  it("allows sparse labels but hides low-zoom bulk text", () => {
    const fixtures = [fixture, { ...fixture, id: "f2", x: 320 }];
    expect(canShowFixtureNames(fixtures, 1)).toBe(true);
    expect(canShowFixtureNames(fixtures, 0.5)).toBe(false);
  });
  it("does not display a label over a neighboring marker", () => {
    expect(canShowFixtureNames([fixture, { ...fixture, id: "f2", x: 100 }], 1)).toBe(false);
  });
});
