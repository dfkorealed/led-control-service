import { readTokenValue, type ReportManifest } from "./report-renderer";

export type PdfTokenMapping = { path: string; type: string; block: number; group: number };
export type PdfTextRun = { index: number; part: number; value: string; x: number; y: number };
type TokenState = { value: string; nextPart: number };
type GroupState = { x: number; lastIndex: number; tokens: Map<number, TokenState> };

/** Recover page/top-to-bottom row/left-to-right column order from drawn coordinates.
 * Only column continuations inside the same oversized row may interleave across pages.
 * Neither token-map ordering nor content-stream operator ordering defines physical order.
 */
export function physicalPdfManifest(mapping: PdfTokenMapping[], pages: PdfTextRun[][]): ReportManifest {
  const blocks = new Map<number, Map<number, GroupState>>();
  let previousBlock = -1;
  for (const runs of pages) {
    const pageBlocks = new Map<number, PdfTextRun[]>();
    for (const run of runs) {
      const block = mapping[run.index].block;
      pageBlocks.set(block, [...(pageBlocks.get(block) ?? []), run]);
    }
    const orderedBlocks = [...pageBlocks].sort(([, a], [, b]) => Math.max(...b.map(run => run.y)) - Math.max(...a.map(run => run.y)));
    let previousBottom = Infinity;
    for (const [block, blockRuns] of orderedBlocks) {
      const top = Math.max(...blockRuns.map(run => run.y));
      if (block < previousBlock || top >= previousBottom) throw new Error("Invalid physical report row order");
      previousBottom = Math.min(...blockRuns.map(run => run.y));
      previousBlock = block;
      const groups = blocks.get(block) ?? new Map<number, GroupState>();
      blocks.set(block, groups);
      const pageGroups = new Map<number, PdfTextRun[]>();
      for (const run of blockRuns) {
        const group = mapping[run.index].group;
        pageGroups.set(group, [...(pageGroups.get(group) ?? []), run]);
      }
      let previousGroup = -1;
      for (const [group, groupRuns] of [...pageGroups].sort(([, a], [, b]) => a[0].x - b[0].x)) {
        if (group <= previousGroup) throw new Error("Invalid physical report column order");
        previousGroup = group;
        const state = groups.get(group) ?? { x: groupRuns[0].x, lastIndex: -1, tokens: new Map<number, TokenState>() };
        groups.set(group, state);
        for (const run of groupRuns.sort((a, b) => b.y - a.y)) {
          if (run.x !== state.x || run.index < state.lastIndex) throw new Error("Invalid physical report token order");
          const token = state.tokens.get(run.index) ?? { value: "", nextPart: 0 };
          if (run.part !== token.nextPart) throw new Error("Invalid physical report continuation order");
          token.value += run.value;
          token.nextPart++;
          state.tokens.set(run.index, token);
          state.lastIndex = run.index;
        }
      }
    }
  }
  // Normalization is limited to columns of one verified physical row. Rows/pages retain
  // their observed insertion order; text fragments retain their verified occurrence order.
  return [...blocks.values()].flatMap(groups => [...groups.values()].sort((a, b) => a.x - b.x).flatMap(group =>
    [...group.tokens].map(([index, token]) => ({ path: mapping[index].path, value: readTokenValue(token.value, mapping[index].type) }))));
}
