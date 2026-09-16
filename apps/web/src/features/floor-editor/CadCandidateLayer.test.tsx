import { render } from "@testing-library/react";
import type Konva from "konva";
import { createRef } from "react";
import { Stage } from "react-konva";
import { afterEach, describe, expect, it } from "vitest";
import {
  CadCandidateLayer,
  buildCadCandidateSpatialIndex,
  findCadCandidateAtPoint,
  queryCadCandidates
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
  afterEach(() => document.body.replaceChildren());

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

  it("culls drawing to the viewport and bounds pointer lookup for 1,000 candidates", () => {
    const index = buildCadCandidateSpatialIndex(candidates);
    const visible = queryCadCandidates(index, { x: 0, y: 0, width: 250, height: 250 });
    const lookup = findCadCandidateAtPoint(index, { x: 100, y: 100 }, 12);

    expect(visible.length).toBeLessThan(20);
    expect(visible).toContainEqual(expect.objectContaining({ x: 100, y: 100 }));
    expect(lookup.candidate).toEqual(expect.objectContaining({ x: 100, y: 100 }));
    expect(lookup.inspectedCount).toBeLessThanOrEqual(64);
  });

  it("keeps pointer work bounded even when all candidates occupy one dense cell", () => {
    const dense = candidates.map((candidate, index) => ({ ...candidate, x: index / 1_000, y: index / 1_000 }));
    const lookup = findCadCandidateAtPoint(buildCadCandidateSpatialIndex(dense), { x: 0, y: 0 }, 12);
    expect(lookup.inspectedCount).toBeLessThanOrEqual(64);
  });
});
