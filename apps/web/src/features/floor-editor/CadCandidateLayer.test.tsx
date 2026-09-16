import { render } from "@testing-library/react";
import type Konva from "konva";
import { createRef } from "react";
import { Stage } from "react-konva";
import { afterEach, describe, expect, it } from "vitest";
import { CadCandidateLayer } from "./CadCandidateLayer";

describe("CadCandidateLayer", () => {
  afterEach(() => document.body.replaceChildren());

  it("renders 1,000 candidates through one Konva Shape in one Layer", () => {
    const stageRef = createRef<Konva.Stage>();
    const candidates = Array.from({ length: 1_000 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sourceEntityId: `insert-${index}`,
      layerName: "LIGHT",
      blockName: "LED",
      x: index % 100,
      y: Math.floor(index / 100),
      rotation: 0,
      confidence: 0.9,
      detectionMethod: "rule_based" as const,
      provider: null,
      model: null,
      inputDigest: null,
      reviewStatus: "pending" as const
    }));

    render(
      <Stage ref={stageRef} width={1200} height={800}>
        <CadCandidateLayer
          candidates={candidates}
          acceptedCandidateIds={new Set(candidates.map((item) => item.id))}
          transform={{ x: 0, y: 0, scaleX: 1, scaleY: 1 }}
          zoom={1}
          onToggle={() => undefined}
        />
      </Stage>
    );

    const layers = stageRef.current?.getLayers() ?? [];
    expect(layers).toHaveLength(1);
    expect(layers[0].find(".cad-candidate-batch")).toHaveLength(1);
    expect(layers[0].getChildren()).toHaveLength(1);
  });
});
