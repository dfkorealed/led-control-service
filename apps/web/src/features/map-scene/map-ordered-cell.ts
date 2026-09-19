import { compareMapDisplayFragmentKeys, type MapDisplayTile } from "@led-control/shared/map-display-contracts";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import type { CadSceneLayerState } from "../cad-scene/CadSceneRenderer";
import { MapPaintWindow, createMapPageCursor, type MapPageRef } from "./map-paint-window";
import { mergeMapPaintStreams } from "./map-ordered-pages";
import { MapOrderedPainter } from "./map-ordered-painter";
import { paintMapElement } from "./map-native-painter";

export async function paintMapOrderedCell(options: {
  tiles: readonly MapDisplayTile[]; drafts: readonly MapElement[]; layers: ReadonlyMap<string, CadSceneLayerState>;
  window: MapPaintWindow; context: CanvasRenderingContext2D; zoom: number; signal: AbortSignal;
  excludedIds: ReadonlySet<string>; excludedGroupIds?: ReadonlySet<string>;
  reserve(key: string, bytes: number): void;
}): Promise<void> {
  const { tiles, layers, window, context, zoom, signal, reserve } = options;
  reserve("page-index", tiles.reduce((sum, tile) => sum + 128 + (tile.pages?.length ?? 0) * 64, 0));
  const byLayer = new Map<string, Map<string, MapPageRef[]>>();
  for (const tile of tiles) {
    if (!tile.pages) throw new Error("Ordered map tile is missing page metadata");
    for (const page of tile.pages) {
      if (layers.get(page.layerId)?.visible === false) continue;
      const streams = byLayer.get(page.layerId) ?? new Map<string, MapPageRef[]>(); byLayer.set(page.layerId, streams);
      const key = `${tile.tileX}:${tile.tileY}:${tile.lod}`;
      const refs = streams.get(key) ?? []; streams.set(key, refs); refs.push({ tile, page });
    }
  }
  for (const draft of options.drafts) if (!byLayer.has(draft.layerId)) byLayer.set(draft.layerId, new Map());
  const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const order = [...byLayer.keys()].sort((a, b) => (layers.get(a)?.order ?? 0) - (layers.get(b)?.order ?? 0) || ordinal(a, b));
  const painter = new MapOrderedPainter(context, zoom, bytes => reserve("path", bytes));
  const draftKey = (element: MapElement) => ({ elementId: element.id, zIndex: element.zIndex, fragmentOrder: 0 });
  let yieldedAt = performance.now();
  try {
    for (const layer of order) {
      const streams = [...byLayer.get(layer)!.values()].map(refs => {
        refs.sort((a, b) => a.page.sequence - b.page.sequence);
        return createMapPageCursor(refs, window);
      });
      const drafts = options.drafts.filter(element => element.layerId === layer)
        .sort((a, b) => compareMapDisplayFragmentKeys(draftKey(a), draftKey(b)));
      let draftIndex = 0;
      const paintDraft = () => {
        painter.finish(); const element = drafts[draftIndex++];
        // Draft geometry is already accounted by the sparse canonical store;
        // reserve its temporary native path separately from persisted pages.
        const points = element.type === "polygon" ? element.geometry.outer.length + element.geometry.holes.reduce((n, ring) => n + ring.length, 0)
          : element.type === "polyline" ? element.geometry.points.length : 1024;
        reserve("path", points * 64 + 1024);
        try { paintMapElement(context, element, zoom); } finally { context.beginPath(); reserve("path", 0); }
      };
      for await (const record of mergeMapPaintStreams(streams, { signal, reserveHeads: bytes => reserve("heads", bytes) })) {
        signal.throwIfAborted();
        while (draftIndex < drafts.length && compareMapDisplayFragmentKeys(draftKey(drafts[draftIndex]), record.primitive) < 0) paintDraft();
        if (!options.excludedIds.has(record.primitive.elementId) &&
            !(record.primitive.groupId && options.excludedGroupIds?.has(record.primitive.groupId))) painter.paint(record);
        if (performance.now() - yieldedAt >= 8) { await new Promise<void>(resolve => setTimeout(resolve, 0)); yieldedAt = performance.now(); }
      }
      while (draftIndex < drafts.length) paintDraft();
      painter.finish();
    }
  } finally { painter.cancel(); reserve("page-index", 0); }
}
