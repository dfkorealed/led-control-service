import type { EditorFixture } from "./editor-types";
import type { Point } from "./geometry";

export function canShowFixtureNames(fixtures: EditorFixture[], zoom: number): boolean {
  if (zoom < 0.7) return false;
  type Box = { left: number; right: number; top: number; bottom: number };
  const cells = new Map<string, Box[]>();
  // Reserve each marker plus its full text box. Any collision hides bulk names;
  // the single focused fixture gets a separate screen-sized label above the layers.
  for (const fixture of fixtures) {
    const radius = (fixture.size ?? 20) / 2;
    const box = { left: fixture.x - radius, right: fixture.x + radius + 155, top: fixture.y - Math.max(radius, 7), bottom: fixture.y + Math.max(radius, 7) };
    const keys: string[] = [];
    for (let x = Math.floor(box.left / 200); x <= Math.floor(box.right / 200); x++) {
      for (let y = Math.floor(box.top / 200); y <= Math.floor(box.bottom / 200); y++) {
        const key = `${x}:${y}`;
        if (cells.get(key)?.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) return false;
        keys.push(key);
      }
    }
    for (const key of keys) {
      const entries = cells.get(key);
      if (entries) entries.push(box);
      else cells.set(key, [box]);
    }
  }
  return true;
}

export function selectedFixtureLabelLayout(fixture: EditorFixture, pan: Point, zoom: number, viewport: { width: number; height: number }) {
  const width = Math.min(220, Math.max(80, fixture.name.length * 8 + 12), Math.max(1, viewport.width - 8));
  const height = 28;
  const offset = (fixture.size ?? 20) * zoom / 2 + 8;
  const x = Math.max(4, Math.min(viewport.width - width - 4, pan.x + fixture.x * zoom + offset));
  const y = Math.max(4, Math.min(viewport.height - height - 4, pan.y + fixture.y * zoom + offset));
  return { x: (x - pan.x) / zoom, y: (y - pan.y) / zoom, scaleX: 1 / zoom, scaleY: 1 / zoom, width, height };
}
