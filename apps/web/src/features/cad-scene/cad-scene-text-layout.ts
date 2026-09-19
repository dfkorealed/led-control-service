import type { CadTextBatch, CadTextEntry } from "./cad-scene-worker";

export interface CadTextPlacement {
  entry: CadTextEntry;
  x: number;
  y: number;
  width: number;
}

/** Deterministic packing shared by worker admission and the actual atlas.
 * Repeated strings share glyph pixels but retain every native text quad. */
export function packCadDisplayText(batch: CadTextBatch): { rowHeight: number; pages: CadTextPlacement[][]; byteSize: number } {
  const font = batch.fontPixelSize ?? 32;
  const rowHeight = font + 4;
  const pages: CadTextPlacement[][] = [[]];
  const glyphs = new Map<string, { page: number; placement: CadTextPlacement }>();
  let x = 0;
  let y = 0;
  for (const entry of batch.entries) {
    const existing = glyphs.get(entry.text);
    if (existing) {
      pages[existing.page].push({ ...existing.placement, entry });
      continue;
    }
    const width = Math.min(2048, Math.max(8, Math.ceil(entry.text.length * font * 1.5) + 4));
    if (x + width > 2048) { x = 0; y += rowHeight; }
    if (y + rowHeight > 2048) { pages.push([]); x = 0; y = 0; }
    const placement = { entry, x, y, width };
    pages.at(-1)!.push(placement);
    glyphs.set(entry.text, { page: pages.length - 1, placement });
    x += width;
  }
  let byteSize = 0;
  for (const page of pages) {
    let width = 0;
    let height = 0;
    for (const placement of page) {
      width = Math.max(width, placement.x + placement.width);
      height = Math.max(height, placement.y + rowHeight);
    }
    byteSize += width * height * 4;
  }
  return { rowHeight, pages, byteSize };
}
