import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CadSceneManifest } from "@led-control/shared";
import { describe, expect, it, vi } from "vitest";
import { CadSceneRenderer, type CadSceneRenderBackend } from "./CadSceneRenderer";
import { CadSceneMemoryBudget } from "./cad-scene-memory-budget";
import { createCadSceneWorkerClient } from "./cad-scene-worker";

// Explicit local evidence harness; converter artifacts are not repository test
// fixtures and must not make ordinary CI depend on a developer's temp folder.
const root = process.env.CAD_SCENE_ACTUAL_ROOT;
describe.skipIf(!root)("actual native CAD display coverage", () => {
  it.each(["cad-region-final-1-1dTvts", "cad-region-final-2-DeOtAL"])("keeps every part of %s within 32 MiB", async name => {
    const directory = join(root!, name);
    const manifestName = (await readdir(directory)).find(file => file.endsWith(".json") && file !== "response.json")!;
    const manifest: CadSceneManifest = JSON.parse(await readFile(join(directory, manifestName), "utf8"));
    const budget = new CadSceneMemoryBudget(32 * 1024 * 1024);
    const resident = new Map<string, { gpu: number; cpu: number; text: number }>();
    let peak = 0;
    const backend: CadSceneRenderBackend = {
      mount: async () => undefined, resize: () => undefined, setCamera: () => undefined,
      render: () => undefined, suspend: () => undefined, destroy: () => undefined,
      replaceTile(key, tile) {
        resident.set(key, { gpu: tile.memory.gpuBytes, cpu: tile.memory.cpuBytes, text: tile.memory.textAtlasBytes });
        peak = Math.max(peak, budget.totalBytes);
      },
      removeTile(key) { resident.delete(key); }
    };
    const onError = vi.fn();
    const onDegraded = vi.fn();
    const renderer = new CadSceneRenderer({ manifest, displayQuality: true, memoryBudget: budget,
      worker: createCadSceneWorkerClient(), backendFactory: () => backend, onError, onDegraded,
      loadTile: async tile => new Uint8Array(await readFile(join(directory, `${tile.assetId}.bin`))) });
    const started = performance.now();
    try {
      await renderer.mount(document.createElement("canvas"));
      await renderer.setCamera({ centerX: manifest.width / 2, centerY: manifest.height / 2,
        viewportWidth: 1000, viewportHeight: 600, zoom: Math.min(1000 / manifest.width, 600 / manifest.height) });
      expect(onError).not.toHaveBeenCalled();
      expect(onDegraded).not.toHaveBeenCalled();
      expect(resident.size).toBe(manifest.tiles.length);
      expect(peak).toBeLessThanOrEqual(32 * 1024 * 1024);
      console.info(JSON.stringify({ fixture: name, parts: resident.size, totalParts: manifest.tiles.length,
        accountedPeakMiB: peak / 1024 / 1024, elapsedMs: Math.round(performance.now() - started) }));
    } finally { renderer.destroy(); }
    expect(budget.totalBytes).toBe(0);
  }, 60_000);
});
