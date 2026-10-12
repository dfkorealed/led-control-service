import Konva from "konva";
import "../../styles.css";
import { createRoot } from "react-dom/client";
import { FloorEditorCanvas } from "../floor-editor/FloorEditorCanvas";
import { createFixturePlacementRowRegistry } from "../floor-editor/FixturePlacementList";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import type { FloorEditorState } from "../floor-editor/editor-types";

/** Test-only Canvas mount avoids unrelated View/session providers. */
export function mountPanHitFixture(initial: FloorEditorState) {
  const store = useFloorEditorStore;
  store.getState().initialize(initial, "pan-hit-fixture");
  document.body.style.margin = "0";
  const host = document.createElement("div");
  host.style.cssText = "width:100vw;height:100vh;position:relative";
  const style = document.createElement("style");
  style.textContent = '[data-testid="floor-editor-canvas"]{height:100%;width:100%;position:relative;overflow:hidden}';
  document.body.replaceChildren(style, host);
  createRoot(host).render(<FloorEditorCanvas rowRegistry={createFixturePlacementRowRegistry()} />);
  return { snapshot: () => {
    const stage = Konva.stages.at(-1), layer = stage?.findOne<Konva.Layer>(".editor-fixture-layer");
    const point = stage?.findOne<Konva.Group>(".fixture-lamp")?.getAbsolutePosition();
    const ratio = layer?.getCanvas().getPixelRatio() ?? 1;
    const pixel = layer && point ? [...layer.getContext().getImageData(Math.floor(point.x * ratio), Math.floor(point.y * ratio), 1, 1).data] : [];
    return { selected: store.getState().selectedFixtureIds, pixel,
      listening: stage?.getLayers().filter(candidate =>
        ["editor-object-layer", "editor-fixture-layer", "editor-overlay-layer"].includes(candidate.name())).map(candidate => candidate.listening()) };
  } };
}
