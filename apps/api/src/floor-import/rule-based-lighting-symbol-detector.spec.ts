import type { NormalizedCadDocument, NormalizedCadInsert } from "./cad-types";
import { RuleBasedLightingSymbolDetector } from "./rule-based-lighting-symbol-detector";

function candidate(index: number, layer = "LIGHTING", blockName = "LED_FIXTURE"): NormalizedCadInsert {
  return {
    type: "insert", sourceEntityId: `insert-${index}`, layer, blockName,
    position: { x: index, y: index * 2, z: 0 }, rotation: index % 360, scale: { x: 1, y: 1, z: 1 }
  };
}

function cad(entities: NormalizedCadDocument["entities"]): NormalizedCadDocument {
  return { version: 1, bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 2000 }, blocks: [], entities };
}

describe("rule-based lighting symbol detector", () => {
  it("detects 1,000 repeated INSERTs only when layer and block evidence intersect", async () => {
    const entities = Array.from({ length: 1000 }, (_, index) => candidate(index));
    entities.push(candidate(1001, "DECOR", "LED_FIXTURE"));
    entities.push(candidate(1002, "LIGHTING", "TREE"));

    const detected = await new RuleBasedLightingSymbolDetector().detect(cad(entities));

    expect(detected).toHaveLength(1000);
    expect(detected[999]).toMatchObject({
      sourceEntityId: "insert-999", layerName: "LIGHTING", blockName: "LED_FIXTURE",
      position: { x: 999, y: 1998, z: 0 }, rotation: 279, method: "rule",
      evidence: ["layer_pattern", "block_pattern", "block_frequency"]
    });
  });

  it("uses a configurable site profile and excludes one-off decorative symbols", async () => {
    const detector = new RuleBasedLightingSymbolDetector({
      layerNameTokens: ["LUMINAIRE"], blockNameTokens: ["TYPE-X"], minimumBlockOccurrences: 2,
      confidence: 0.91, maxCandidates: 10
    });
    const detected = await detector.detect(cad([
      candidate(1, "LUMINAIRE-1F", "TYPE-X-600"),
      candidate(2, "LUMINAIRE-1F", "TYPE-X-600"),
      candidate(3, "LUMINAIRE-1F", "TYPE-Y-DECOR")
    ]));

    expect(detected).toHaveLength(2);
    expect(detected.every(item => item.confidence === 0.91)).toBe(true);
  });

  it("fails closed instead of truncating an excessive candidate result", async () => {
    const detector = new RuleBasedLightingSymbolDetector({ maxCandidates: 1, minimumBlockOccurrences: 2 });
    await expect(detector.detect(cad([candidate(1), candidate(2)]))).rejects.toThrow(/candidate.*limit/i);
  });
});
