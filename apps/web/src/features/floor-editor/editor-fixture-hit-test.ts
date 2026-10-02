import type { Point } from "./geometry";

export interface FixtureHitCandidate {
  id: string;
  x: number;
  y: number;
  size: number;
  strokeWidth: number;
}

/** Candidates are in existing paint order. A padded hit must never cover an
 * actual fixture body; padding otherwise resolves to the closest centre. */
export function resolveFixtureHit(candidates: readonly FixtureHitCandidate[], point: Point, zoom: number): FixtureHitCandidate | null {
  if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  let result: FixtureHitCandidate | null = null;
  let bestBody = false;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const radius = (candidate.size + candidate.strokeWidth) * zoom / 2;
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y) * zoom;
    if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(distance) || distance > Math.max(22, radius)) continue;
    const body = distance <= radius;
    if (result && (bestBody && !body || body === bestBody && distance > bestDistance)) continue;
    result = candidate;
    bestBody = body;
    bestDistance = distance;
  }
  return result;
}
