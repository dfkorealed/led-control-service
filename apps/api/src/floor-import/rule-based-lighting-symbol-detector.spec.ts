import type { NormalizedCadDocument, NormalizedCadInsert } from "./cad-types";
import { RuleBasedLightingSymbolDetector } from "./rule-based-lighting-symbol-detector";

function candidate(index: number, layer = "LIGHTING", blockName = "LED_FIXTURE"): NormalizedCadInsert {
  return {
    type: "insert", sourceEntityId: `insert-${index}`, layer, blockName,
    position: { x: index, y: index * 2, z: 0 }, rotation: index % 360, scale: { x: 1, y: 1, z: 1 }, attributes: []
  };
}

function cad(entities: NormalizedCadDocument["entities"]): NormalizedCadDocument {
  const names = [...new Set(entities.filter((entity): entity is NormalizedCadInsert => entity.type === "insert").map(entity => entity.blockName))];
  return {
    version: 1, bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 2000 },
    blocks: names.map(name => ({ name, basePoint: { x: 0, y: 0, z: 0 }, entities: [] })), entities
  };
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

  it("uses token boundaries and rejects LEDGER plus SCHEDULED_NOTE false positives", async () => {
    const detected = await new RuleBasedLightingSymbolDetector().detect(cad([
      candidate(1, "LEDGER", "SCHEDULED_NOTE"),
      candidate(2, "LEDGER", "SCHEDULED_NOTE")
    ]));
    expect(detected).toEqual([]);
  });

  it("records ATTRIB and nearby text evidence while honoring configurable deny evidence", async () => {
    const first = candidate(1);
    first.position = { x: 0, y: 0, z: 0 };
    first.attributes = [{ sourceEntityId: "A1", tag: "TYPE", value: "LED PANEL", position: { x: 0, y: 0, z: 0 }, rotation: 0, height: 1 }];
    const second = candidate(2);
    second.position = { x: 100, y: 100, z: 0 };
    const document = cad([
      first, second,
      { type: "text", sourceEntityId: "near", layer: "NOTE", position: { x: 1, y: 0, z: 0 }, rotation: 0, height: 1, text: "LIGHT 600x600" }
    ]);
    const detected = await new RuleBasedLightingSymbolDetector().detect(document);
    expect(detected[0].evidence).toEqual(["layer_pattern", "block_pattern", "block_frequency", "attribute_pattern", "nearby_text_pattern"]);

    const denyProfile = {
      denyNearbyTextTokens: ["DO NOT IMPORT"], nearbyTextDistance: 5,
      layerNameTokens: ["LIGHTING"], blockNameTokens: ["LED FIXTURE"]
    };
    document.entities.push({ type: "text", sourceEntityId: "deny", layer: "NOTE", position: { x: 0.5, y: 0, z: 0 }, rotation: 0, height: 1, text: "DO NOT IMPORT" });
    const denied = await new RuleBasedLightingSymbolDetector(denyProfile).detect(document);
    expect(denied.map(item => item.sourceEntityId)).toEqual(["insert-2"]);
  });

  it("expands nested INSERTs to world coordinates with stable source paths", async () => {
    const nested: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 20, maxY: 30 },
      blocks: [
        { name: "LED_FIXTURE", basePoint: { x: 0, y: 0, z: 0 }, entities: [{ type: "circle", sourceEntityId: "shape", layer: "0", center: { x: 0, y: 0, z: 0 }, radius: 0.5 }] },
        { name: "FLOOR_WRAPPER", basePoint: { x: 0, y: 0, z: 0 }, entities: [
          { ...candidate(1), sourceEntityId: "N1", position: { x: 1, y: 0, z: 0 }, rotation: 10 },
          { ...candidate(2), sourceEntityId: "N2", position: { x: 2, y: 0, z: 0 }, rotation: 10 }
        ] }
      ],
      entities: [{ type: "insert", sourceEntityId: "ROOT", layer: "0", blockName: "FLOOR_WRAPPER", position: { x: 10, y: 20, z: 0 }, rotation: 90, scale: { x: 2, y: 2, z: 1 }, attributes: [] }]
    };

    const detected = await new RuleBasedLightingSymbolDetector().detect(nested);
    expect(detected).toMatchObject([
      { sourceEntityId: "ROOT/N1", position: { x: 10, y: 22, z: 0 }, rotation: 100 },
      { sourceEntityId: "ROOT/N2", position: { x: 10, y: 24, z: 0 }, rotation: 100 }
    ]);
  });
});
