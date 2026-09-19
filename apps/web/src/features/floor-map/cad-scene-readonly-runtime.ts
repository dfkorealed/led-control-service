import type { CadElementOverride } from "@led-control/shared";
import type {
  CadSceneRenderer,
  CadSceneRendererOptions,
  CadSceneRenderBackend
} from "../cad-scene/CadSceneRenderer";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import type { DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { assertBoundedCadTransforms, preloadMovedCadTiles } from "./cad-moved-preload";
import { createCadOverrideWorker } from "../floor-editor/cad-editor-runtime";

let ownerSequence = 0;

export type ReadOnlyCadSceneRenderer = Pick<
  CadSceneRenderer,
  "mount" | "setCamera" | "setLayerStates" | "destroy"
>;

export async function createReadOnlyCadSceneRenderer(
  options: Omit<CadSceneRendererOptions, "worker">,
  overrides: ReadonlyMap<string, CadElementOverride>
): Promise<ReadOnlyCadSceneRenderer> {
  const [rendererModule, workerModule] = await Promise.all([
    import("../cad-scene/CadSceneRenderer"),
    import("../cad-scene/cad-scene-worker"),
    // Despite its name, Pixi's extension replaces dynamic Function generation
    // with static uniform/shader synchronizers for CSP without unsafe-eval.
    import("pixi.js/unsafe-eval")
  ]);
  const moved = new Map([...overrides].filter(([, value]) => value.transform && !value.hidden));
  const baseOverrides = new Map(overrides);
  for (const [id, value] of moved) baseOverrides.set(id, { ...value, hidden: true });
  const worker = createCadOverrideWorker(
    workerModule.createCadSceneWorkerClient(),
    () => baseOverrides,
    tile => assertBoundedCadTransforms(tile, baseOverrides)
  );
  const memoryBudget = options.memoryBudget ?? new CadSceneMemoryBudget(
    (options.platform === "mobile" ? 32 : 128) * 1024 * 1024
  );
  if (moved.size === 0) return new rendererModule.CadSceneRenderer({ ...options, worker, memoryBudget, displayQuality: true });

  const owner = `monitoring-moved-${++ownerSequence}`;
  const controller = new AbortController();
  const preloadWorker = workerModule.createCadSceneWorkerClient();
  let overlays = new Map<string, DecodedCadSceneTile>();
  let hiddenLayers = new Set<string>();
  let backend: CadSceneRenderBackend | null = null;
  const sync = () => {
    for (const [key, tile] of overlays) backend?.replaceTile(key, tile, new Set(), hiddenLayers);
  };
  const renderer = new rendererModule.CadSceneRenderer({
    ...options, worker, memoryBudget, displayQuality: true,
    backendFactory: () => {
      const target = options.backendFactory?.() ?? new rendererModule.PixiCadSceneRenderBackend();
      return {
        async mount(canvas, settings) {
          await target.mount(canvas, settings);
          backend = target;
          sync();
        },
        resize: (...args) => target.resize(...args),
        setCamera: camera => {
          // CadSceneRenderer can reuse a suspended backend after context
          // restore without calling mount again. Rehydrate our pinned tiles.
          if (backend !== target) { backend = target; sync(); }
          target.setCamera(camera);
        },
        replaceTile: (...args) => target.replaceTile(...args),
        removeTile: key => target.removeTile(key),
        render: () => target.render(),
        suspend: () => { backend = null; target.suspend(); },
        destroy: () => { backend = null; target.destroy(); }
      };
    }
  });
  return {
    async mount(canvas) {
      try {
        overlays = await preloadMovedCadTiles(options.manifest, moved, options.loadTile, preloadWorker, memoryBudget, owner, controller.signal);
        controller.signal.throwIfAborted();
        await renderer.mount(canvas);
      } catch (error) {
        memoryBudget.releaseOwner(owner);
        throw error;
      }
    },
    setCamera: camera => renderer.setCamera(camera),
    setLayerStates(states) {
      hiddenLayers = new Set([...states].filter(([, state]) => !state.visible).map(([name]) => name));
      sync();
      renderer.setLayerStates(states);
      backend?.render();
    },
    destroy() {
      controller.abort();
      renderer.destroy();
      preloadWorker.destroy();
      overlays.clear();
      memoryBudget.releaseOwner(owner);
    }
  };
}
