import type { CadSceneTile } from "@led-control/shared";
import { describe, expect, it, vi } from "vitest";
import { buildCadGeometryBatches, type DecodedCadSceneTile } from "./cad-scene-worker";

const pixi = vi.hoisted(() => {
  const geometries: MockGeometry[] = [];

  class MockContainer {
    readonly children: unknown[] = [];
    readonly scale = { set: vi.fn() };
    readonly position = { set: vi.fn() };

    addChild(child: unknown): void {
      this.children.push(child);
    }

    removeFromParent(): void {}

    destroy(): void {}
  }

  class MockGeometry {
    readonly destroy = vi.fn();

    constructor(_options: unknown) {
      geometries.push(this);
    }
  }

  class MockMesh {
    tint = "";
    alpha = 1;

    constructor(_options: unknown) {}
  }

  class MockRenderer {
    readonly init = vi.fn(async () => undefined);
    readonly resize = vi.fn();
    readonly render = vi.fn();
    readonly destroy = vi.fn();
  }

  const texture = { destroy: vi.fn() };
  return { MockContainer, MockGeometry, MockMesh, MockRenderer, geometries, texture };
});

vi.mock("pixi.js", () => ({
  Container: pixi.MockContainer,
  Mesh: pixi.MockMesh,
  MeshGeometry: pixi.MockGeometry,
  Texture: { WHITE: pixi.texture, from: vi.fn(() => ({ destroy: vi.fn() })) },
  WebGLRenderer: pixi.MockRenderer
}));

import { PixiCadSceneRenderBackend } from "./CadSceneRenderer";

const tileDescriptor: CadSceneTile = {
  version: 1,
  sceneId: "11111111-1111-4111-8111-111111111111",
  tileX: 0,
  tileY: 0,
  lod: 0,
  part: 0,
  assetId: "33333333-3333-4333-8333-333333333333",
  primitiveCount: 1,
  byteSize: 256,
  sha256: "0".repeat(64),
  bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
};

describe("PixiCadSceneRenderBackend", () => {
  it("destroys tile geometry buffers immediately when a tile is removed", async () => {
    const backend = new PixiCadSceneRenderBackend();
    const decoded: DecodedCadSceneTile = {
      ...buildCadGeometryBatches([{
        elementId: "line-1",
        groupId: null,
        layerName: "WALLS",
        sourceType: "LINE",
        bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        clipBounds: null,
        style: { strokeColor: "#112233", fillColor: null, strokeWidth: 1, opacity: 1 },
        type: "line",
        geometry: { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }
      }]),
      descriptor: tileDescriptor,
      byteSize: 256
    };
    await backend.mount(document.createElement("canvas"), { resolution: 1 });
    backend.replaceTile("tile-1", decoded, new Set());

    backend.removeTile("tile-1");

    expect(pixi.geometries).toHaveLength(1);
    expect(pixi.geometries[0].destroy).toHaveBeenCalledWith(true);
  });
});
