import type { EditorFixture } from "./editor-types";
import type { PlacementPoint } from "./editor-store";
import type { Bounds } from "./geometry";

export interface PlacementOptions {
  mode: "grid" | "line"; x: number; y: number; width: number; height: number;
  columns: number; rows: number; gapX: number; gapY: number; angle: number;
}
export function createPlacementPreview(fixtures: EditorFixture[], options: PlacementOptions, bounds: Bounds, allFixtures: EditorFixture[]): { points: PlacementPoint[]; error: string | null } {
  const fail = (error: string) => ({ points: [], error });
  if (!fixtures.length) return fail("배치할 조명을 선택하세요.");
  if (Object.entries(options).some(([key, value]) => key !== "mode" && !Number.isFinite(value))) return fail("유효한 숫자를 입력하세요.");
  if (options.width <= 0 || options.height <= 0 || options.gapX <= 0 || options.gapY <= 0 || !Number.isInteger(options.columns) || options.columns < 1 || !Number.isInteger(options.rows) || options.rows < 1) return fail("영역, 행/열, 간격을 확인하세요.");
  if (options.mode === "grid" && options.rows * options.columns < fixtures.length) return fail(`${fixtures.length}개를 배치하려면 행 또는 열을 늘리세요.`);
  const radians = (options.angle % 360) * Math.PI / 180;
  // Cardinal directions must not drift beyond a map edge through floating-point residue.
  const cos = Math.abs(Math.cos(radians)) < 1e-12 ? 0 : Math.cos(radians);
  const sin = Math.abs(Math.sin(radians)) < 1e-12 ? 0 : Math.sin(radians);
  const points = fixtures.map((f, index) => ({ id: f.id,
    x: options.x + (options.mode === "grid" ? index % options.columns * options.gapX : cos * index * options.gapX),
    y: options.y + (options.mode === "grid" ? Math.floor(index / options.columns) * options.gapY : sin * index * options.gapX)
  }));
  // Lines use absolute travel from their origin; grids retain their positive rectangle.
  if (points.some((p) => p.x < 0 || p.y < 0 || p.x > bounds.width || p.y > bounds.height
    || (options.mode === "line"
      ? Math.abs(p.x - options.x) > options.width || Math.abs(p.y - options.y) > options.height
      : p.x < options.x - 0.001 || p.x > options.x + options.width || p.y < options.y - 0.001 || p.y > options.y + options.height))) return fail("배치 영역이 부족합니다. 개수, 간격 또는 영역을 조정하세요.");
  const ids = new Set(fixtures.map((f) => f.id));
  const others = allFixtures.filter((f) => !ids.has(f.id) && f.placementStatus !== "unplaced");
  const candidates = points.map((p, i) => ({ ...p, size: fixtures[i].size ?? 20 }));
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    if (others.some((f) => Math.hypot(p.x - f.x, p.y - f.y) < (p.size + (f.size ?? 20)) / 2)
      || candidates.slice(0, i).some((f) => Math.hypot(p.x - f.x, p.y - f.y) < (p.size + f.size) / 2)) return fail("조명이 겹칩니다. 간격 또는 시작 위치를 조정하세요.");
  }
  return { points, error: null };
}

export type AlignMode = "left" | "right" | "top" | "bottom" | "center-x" | "center-y" | "distribute-x" | "distribute-y";
export function alignFixtures(fixtures: EditorFixture[], mode: AlignMode): PlacementPoint[] {
  if (!fixtures.length) return [];
  const axis = ["left", "right", "center-x", "distribute-x"].includes(mode) ? "x" : "y";
  const sorted = [...fixtures].sort((a, b) => a[axis] - b[axis]);
  const min = sorted[0][axis], max = sorted[sorted.length - 1][axis];
  return sorted.map((f, index) => ({ id: f.id, x: f.x, y: f.y, [axis]: mode.startsWith("distribute") ? min + (max - min) * index / Math.max(1, sorted.length - 1) : mode.startsWith("center") ? (min + max) / 2 : mode === "right" || mode === "bottom" ? max : min }));
}
