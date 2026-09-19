import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { MapDocumentRef } from "@led-control/shared/map-document-contracts";
import { createMapDocumentSource } from "../../api/map-document";
import { PixiCadSceneRenderBackend } from "../cad-scene/CadSceneRenderer";
import { MapSceneRenderer, type MapSceneRendererOptions } from "./MapSceneRenderer";
import { MapSceneCanvas, type MapSceneCanvasHandle } from "./MapSceneCanvas";

/** Real React/provider/Worker/WebGL fixture, imported only by the smoke test. */
export function mountMapSceneSmoke(documentRef: MapDocumentRef, width: number) {
  const host = document.createElement("div");
  host.style.cssText = `width:${width}px;height:320px`;
  document.body.style.margin = "0";
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const handle = createRef<MapSceneCanvasHandle>();
  const source = createMapDocumentSource({ floorId: "u9b-http", authScope: "smoke:user" });
  const errors: string[] = [], versions: number[] = [], renderers: MapSceneRenderer[] = [];
  let captured = new Uint8Array();
  const camera = { centerX: 256, centerY: 160, zoom: Math.min(1, width / 512), viewportWidth: width, viewportHeight: 320 };
  class RecordingBackend extends PixiCadSceneRenderBackend {
    render() {
      super.render();
      const canvas = host.querySelector("canvas");
      const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
      if (!canvas || !gl || gl.isContextLost()) return;
      captured = new Uint8Array(canvas.width * canvas.height * 4);
      gl.finish(); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, captured);
    }
  }
  const createRenderer = (options: MapSceneRendererOptions) => {
    const renderer = new MapSceneRenderer({ ...options, devicePixelRatio: 1, backendFactory: () => new RecordingBackend() });
    renderers.push(renderer); return renderer;
  };
  const render = (ref: MapDocumentRef, readOnly = false) => root.render(<MapSceneCanvas source={source} documentRef={ref}
    ref={handle} camera={camera} readOnly={readOnly} platform={width === 320 ? "mobile" : "desktop"}
    createRenderer={createRenderer} onManifest={manifest => versions.push(manifest.revision)}
    onError={error => errors.push(error.message)} onDegraded={value => errors.push(value.reason)} />);
  render(documentRef);
  return { handle, errors, versions, renderers, render, dispose: () => root.unmount(),
    canvas: () => host.querySelector("canvas"),
    pixel: (x: number, y: number) => {
      const canvas = host.querySelector("canvas");
      if (!canvas) return [];
      const sx = Math.round((x - camera.centerX) * camera.zoom + width / 2);
      const sy = Math.round((y - camera.centerY) * camera.zoom + 160);
      const offset = ((canvas.height - sy - 1) * canvas.width + sx) * 4;
      return [...captured.slice(offset, offset + 4)];
    }
  };
}
