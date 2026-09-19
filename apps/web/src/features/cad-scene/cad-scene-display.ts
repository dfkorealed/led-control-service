interface Point { x: number; y: number }
interface LineIntervals {
  dx: number;
  dy: number;
  cross: number;
  intervals: Array<[number, number]>;
}

/** Display-only union of collinear strokes on an integer lattice. Source IDs
 * and geometry remain in the original tiles for exact, on-demand picking. */
export class CadDisplayStrokeAccumulator {
  private readonly lines = new Map<string, LineIntervals>();

  constructor(readonly quantum: number, readonly width: number) {}

  add(start: Point, end: Point): void {
    const x1 = 2 * Math.round(start.x / this.quantum);
    const y1 = 2 * Math.round(start.y / this.quantum);
    let x2 = 2 * Math.round(end.x / this.quantum);
    const y2 = 2 * Math.round(end.y / this.quantum);
    // Keep a subpixel native mark instead of dropping a collapsed segment.
    if (x1 === x2 && y1 === y2) x2++;
    let dx = x2 - x1;
    let dy = y2 - y1;
    let a = Math.abs(dx);
    let b = Math.abs(dy);
    while (b !== 0) [a, b] = [b, a % b];
    dx /= a;
    dy /= a;
    if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
    const cross = dx * y1 - dy * x1;
    const key = `${dx}:${dy}:${cross}`;
    const line = this.lines.get(key) ?? { dx, dy, cross, intervals: [] };
    const from = dx * x1 + dy * y1;
    const to = dx * x2 + dy * y2;
    line.intervals.push([Math.min(from, to), Math.max(from, to)]);
    this.lines.set(key, line);
  }

  emit(positions: number[], indices: number[]): void {
    for (const line of this.lines.values()) {
      line.intervals.sort((a, b) => a[0] - b[0]);
      let current = line.intervals[0];
      for (const next of line.intervals.slice(1)) {
        if (next[0] <= current[1]) current[1] = Math.max(current[1], next[1]);
        else { this.emitInterval(line, current, positions, indices); current = next; }
      }
      this.emitInterval(line, current, positions, indices);
    }
  }

  private emitInterval(line: LineIntervals, [from, to]: [number, number], positions: number[], indices: number[]): void {
    const { dx, dy, cross } = line;
    const scale = this.quantum / (2 * (dx * dx + dy * dy));
    const x1 = (dx * from - dy * cross) * scale;
    const y1 = (dy * from + dx * cross) * scale;
    const x2 = (dx * to - dy * cross) * scale;
    const y2 = (dy * to + dx * cross) * scale;
    const normalScale = this.width / (2 * Math.hypot(dx, dy));
    const nx = -dy * normalScale;
    const ny = dx * normalScale;
    const offset = positions.length / 2;
    positions.push(x1 + nx, y1 + ny, x1 - nx, y1 - ny, x2 - nx, y2 - ny, x2 + nx, y2 + ny);
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
}
