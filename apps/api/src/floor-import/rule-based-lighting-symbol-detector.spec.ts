import type { NormalizedCadDocument, NormalizedCadInsert } from "./cad-types";
import { RuleBasedLightingSymbolDetector } from "./rule-based-lighting-symbol-detector";
import { expandCadInserts } from "./cad-geometry";

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
  it("uses the drawing profile exact allowlist and preserves 1,308 review candidates with metadata", async () => {
    const detector = new RuleBasedLightingSymbolDetector({ maxDurationMs: 30_000 });
    const entities = Array.from({ length: 1_308 }, (_, index) => candidate(index, "전등-간선", "몰드바등"));
    entities.push(candidate(2_000, "전등-간선", "몰드바등",));
    entities.at(-1)!.layer = "SCHEDULE";

    const detected = await detector.detect(cad(entities));

    expect(detected).toHaveLength(1_308);
    expect(detected[0]).toMatchObject({
      blockName: "몰드바등",
      evidence: ["layer_pattern", "exact_block_allowlist", "block_frequency"],
      profileVersion: "site-drawing-lighting/2"
    });
    expect(detected[0].profileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

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
      { sourceEntityId: "4:ROOT2:N1", position: { x: 10, y: 22, z: 0 }, rotation: 100 },
      { sourceEntityId: "4:ROOT2:N2", position: { x: 10, y: 24, z: 0 }, rotation: 100 }
    ]);
  });

  it("uses collision-free length-prefixed nested source paths and validates final uniqueness", () => {
    const nested: NormalizedCadDocument = {
      version: 1, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      blocks: [
        { name: "A_BLOCK", basePoint: { x: 0, y: 0, z: 0 }, entities: [{ ...candidate(1), sourceEntityId: "B/C", blockName: "LEAF" }] },
        { name: "AB_BLOCK", basePoint: { x: 0, y: 0, z: 0 }, entities: [{ ...candidate(2), sourceEntityId: "C", blockName: "LEAF" }] },
        { name: "LEAF", basePoint: { x: 0, y: 0, z: 0 }, entities: [] }
      ],
      entities: [
        { ...candidate(3), sourceEntityId: "A", blockName: "A_BLOCK" },
        { ...candidate(4), sourceEntityId: "A/B", blockName: "AB_BLOCK" }
      ]
    };

    const ids = expandCadInserts(nested, { maxExpandedInserts: 10 }).map(item => item.sourceEntityId);
    expect(ids).toEqual(["A", "1:A3:B/C", "A/B", "3:A/B1:C"]);
    expect(new Set(ids).size).toBe(ids.length);

    const duplicate = structuredClone(nested);
    duplicate.entities[1].sourceEntityId = "A";
    expect(() => expandCadInserts(duplicate, { maxExpandedInserts: 10 })).toThrow(/duplicate.*expanded.*source/i);
  });

  it("preserves mirrored INSERT orientation in world rotation and signed scale", () => {
    const mirrored = cad([candidate(1)]);
    const insert = mirrored.entities[0];
    if (insert.type !== "insert") throw new Error("Expected INSERT fixture");
    insert.rotation = 0;
    insert.scale = { x: -2, y: 3, z: -1 };

    expect(expandCadInserts(mirrored, { maxExpandedInserts: 10 })[0]).toMatchObject({
      rotation: 180,
      scale: { x: 2, y: -3, z: -1 }
    });
  });

  it("honors AbortSignal and a monotonic detector deadline", async () => {
    const detector = new RuleBasedLightingSymbolDetector();
    const controller = new AbortController();
    controller.abort();
    await expect(detector.detect(cad([candidate(1), candidate(2)]), { abortSignal: controller.signal })).rejects.toThrow(/aborted/i);

    let tick = 0;
    await expect(detector.detect(cad(Array.from({ length: 1000 }, (_, index) => candidate(index))), {
      maxDurationMs: 10, now: () => tick++
    })).rejects.toThrow(/time.*limit/i);
  });

  it("uses a bounded spatial index for 1,000 candidates and 1,000 pre-tokenized texts", async () => {
    const inserts = Array.from({ length: 1000 }, (_, index) => ({ ...candidate(index), position: { x: index * 100, y: 0, z: 0 } }));
    const texts = Array.from({ length: 1000 }, (_, index) => ({
      type: "text" as const, sourceEntityId: `text-${index}`, layer: "NOTE", position: { x: index * 100 + 1, y: 0, z: 0 },
      rotation: 0, height: 1, text: index === 999 ? "DO NOT IMPORT" : "LIGHT"
    }));
    let tick = 0;
    const detected = await new RuleBasedLightingSymbolDetector().detect(cad([...inserts, ...texts]), {
      maxDurationMs: 300_000, now: () => tick++
    });

    expect(detected).toHaveLength(999);
    expect(detected.at(-1)?.sourceEntityId).toBe("insert-998");
    expect(tick).toBeLessThan(300_000);
  });

  it("observes an AbortSignal fired while running at the maximum cooperative yield interval", async () => {
    const controller = new AbortController();
    const detector = new RuleBasedLightingSymbolDetector({
      maxCandidates: 20_000, maxExpandedInserts: 20_000, cooperativeYieldInterval: 1024
    });
    const detection = detector.detect(cad(Array.from({ length: 10_000 }, (_, index) => candidate(index))), {
      abortSignal: controller.signal
    });
    setTimeout(() => controller.abort(), 0);

    await expect(detection).rejects.toThrow(/aborted/i);
    expect(controller.signal.aborted).toBe(true);
  });

  it("rejects an in-flight abort while tokenizing parser-limit dense nearby text", async () => {
    const controller = new AbortController();
    const denseText = "A".repeat(64 * 1024);
    const texts = Array.from({ length: 49 }, (_, index) => ({
      type: "text" as const, sourceEntityId: `dense-${index}`, layer: "NOTE",
      position: { x: 0, y: 0, z: 0 }, rotation: 0, height: 1, text: denseText
    }));
    const detection = new RuleBasedLightingSymbolDetector({ cooperativeYieldInterval: 1024 }).detect(cad([
      candidate(0), candidate(1), ...texts
    ]), { abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 0);

    await expect(detection).rejects.toThrow(/aborted/i);
    expect(controller.signal.aborted).toBe(true);
  });

  it("rejects an expired deadline during dense nearby-text matcher comparisons", async () => {
    const repeatedTokens = "A ".repeat(5_000);
    // The first 10,000 primitive checks tokenize the text; expiry starts in the adversarial matcher scan.
    const deadlineAfterTokenizationChecks = 11_000;
    let checks = 0;
    const detector = new RuleBasedLightingSymbolDetector({
      minimumBlockOccurrences: 1,
      nearbyTextTokens: ["A B"],
      denyLayerNameTokens: [],
      denyBlockNameTokens: [],
      denyAttributeValueTokens: [],
      denyNearbyTextTokens: []
    });
    const document = cad([
      candidate(0),
      {
        type: "text", sourceEntityId: "adversarial", layer: "NOTE",
        position: { x: 0, y: 0, z: 0 }, rotation: 0, height: 1, text: repeatedTokens
      }
    ]);

    await expect(detector.detect(document, {
      maxDurationMs: 1,
      now: () => checks++ < deadlineAfterTokenizationChecks ? 0 : 2
    })).rejects.toThrow(/time.*limit/i);
  });

  it.each([0, 1.5, 1025])("rejects unsafe cooperative yield interval %p", cooperativeYieldInterval => {
    expect(() => new RuleBasedLightingSymbolDetector({ cooperativeYieldInterval })).toThrow(/cooperative yield interval/i);
  });

  it("rechecks the monotonic deadline immediately after a cooperative yield", async () => {
    let now = 0;
    const detector = new RuleBasedLightingSymbolDetector({
      maxCandidates: 2_000, maxExpandedInserts: 2_000, cooperativeYieldInterval: 1
    });
    const detection = detector.detect(cad(Array.from({ length: 1_000 }, (_, index) => candidate(index))), {
      maxDurationMs: 1, now: () => now
    });
    setTimeout(() => { now = 2; }, 0);

    await expect(detection).rejects.toThrow(/time.*limit/i);
  });
});
