import { act, render } from "@testing-library/react";
import type Konva from "konva";
import { createRef } from "react";
import { Stage } from "react-konva";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CadCandidateLayer,
  buildCadCandidateSpatialIndex,
  findCadCandidateAtPoint,
  queryCadCandidates,
  screenPointToCadWorld
} from "./CadCandidateLayer";

const candidates = Array.from({ length: 1_000 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  sourceEntityId: `insert-${index}`,
  layerName: "LIGHT",
  blockName: "LED",
  x: (index % 100) * 100,
  y: Math.floor(index / 100) * 100,
  rotation: 0,
  confidence: 0.9,
  detectionMethod: "rule_based" as const,
  provider: null,
  model: null,
  inputDigest: null,
  reviewStatus: "pending" as const
}));

describe("CadCandidateLayer", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders 1,000 candidates through one Konva Shape in one Layer", () => {
    const stageRef = createRef<Konva.Stage>();

    render(
      <Stage ref={stageRef} width={1200} height={800}>
        <CadCandidateLayer
          candidates={candidates}
          acceptedCandidateIds={new Set(candidates.map((item) => item.id))}
          transform={{ x: 0, y: 0, scaleX: 1, scaleY: 1 }}
          zoom={1}
          viewportBounds={{ x: 0, y: 0, width: 1200, height: 800 }}
          onToggle={() => undefined}
        />
      </Stage>
    );

    const layers = stageRef.current?.getLayers() ?? [];
    expect(layers).toHaveLength(1);
    expect(layers[0].find(".cad-candidate-batch")).toHaveLength(1);
    expect(layers[0].getChildren()).toHaveLength(1);
  });

  it("culls drawing to the viewport and finds the exact nearest candidate", () => {
    const index = buildCadCandidateSpatialIndex(candidates);
    const visible = queryCadCandidates(index, { x: 0, y: 0, width: 250, height: 250 });
    const lookup = findCadCandidateAtPoint(index, { x: 100, y: 100 }, 12);

    expect(visible.length).toBeLessThan(20);
    expect(visible).toContainEqual(expect.objectContaining({ x: 100, y: 100 }));
    expect(lookup.candidate).toEqual(expect.objectContaining({ x: 100, y: 100 }));
    expect(lookup.inspectedCount).toBeLessThan(candidates.length);
  });

  it("keeps exact nearest-hit correctness when all 1,000 candidates occupy one dense cell", () => {
    const dense = candidates.map((candidate, index) => ({ ...candidate, x: index / 1_000, y: index / 1_000 }));
    const target = dense[999];
    const startedAt = performance.now();
    const lookup = findCadCandidateAtPoint(buildCadCandidateSpatialIndex(dense), target, 12);
    const elapsedMs = performance.now() - startedAt;

    expect(lookup.candidate?.id).toBe(target.id);
    expect(lookup.inspectedCount).toBe(1_000);
    expect(elapsedMs).toBeLessThan(100);
  });

  it("converts a panned and zoomed stage pointer into CAD world coordinates", () => {
    expect(screenPointToCadWorld(
      { x: 310, y: 170 },
      { x: 60, y: -30, scaleX: 2.5, scaleY: 2 }
    )).toEqual({ x: 100, y: 100 });
  });

  it("coalesces rapid pointer moves into one animation-frame lookup", () => {
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const stageRef = createRef<Konva.Stage>();
    const onFocusedCandidateChange = vi.fn();
    render(
      <Stage ref={stageRef} width={1200} height={800}>
        <CadCandidateLayer
          candidates={candidates}
          acceptedCandidateIds={new Set()}
          transform={{ x: 0, y: 0, scaleX: 1, scaleY: 1 }}
          zoom={1}
          viewportBounds={{ x: 0, y: 0, width: 1200, height: 800 }}
          onFocusedCandidateChange={onFocusedCandidateChange}
          onToggle={() => undefined}
        />
      </Stage>
    );
    const stage = stageRef.current!;
    vi.spyOn(stage, "getPointerPosition").mockReturnValue({ x: 100, y: 100 });
    const shape = stage.findOne(".cad-candidate-batch")!;

    shape.fire("mousemove");
    shape.fire("mousemove");
    shape.fire("mousemove");
    expect(onFocusedCandidateChange).not.toHaveBeenCalled();
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => frame?.(16));
    expect(onFocusedCandidateChange).toHaveBeenCalledTimes(1);
    expect(onFocusedCandidateChange).toHaveBeenCalledWith(candidates[101].id);
  });
});
