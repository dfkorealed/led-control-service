import type { NormalizedCadDocument, NormalizedCadEntity } from "./cad-types";
import { CAD_MAX_DETECTED_REGIONS, detectCadRegions } from "./cad-region-detector";

const point = (x: number, y: number) => ({ x, y, z: 0 });

function rectangle(prefix: string, x: number, y: number, width: number, height: number): NormalizedCadEntity[] {
  return [
    { type: "line", sourceEntityId: `${prefix}-top`, layer: "0", start: point(x, y + height), end: point(x + width, y + height) },
    { type: "line", sourceEntityId: `${prefix}-right`, layer: "0", start: point(x + width, y + height), end: point(x + width, y) },
    { type: "line", sourceEntityId: `${prefix}-bottom`, layer: "0", start: point(x + width, y), end: point(x, y) },
    { type: "line", sourceEntityId: `${prefix}-left`, layer: "0", start: point(x, y), end: point(x, y + height) }
  ];
}

function document(entities: NormalizedCadEntity[], blocks: NormalizedCadDocument["blocks"] = []): NormalizedCadDocument {
  return {
    version: 1,
    bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    blocks,
    entities
  };
}

function hugeCurve(type: string): NormalizedCadEntity {
  const base = { sourceEntityId: "huge-curve", layer: "WALL" };
  const radius = 3_000_000;
  if (type === "circle") return { ...base, type, center: point(0, 0), radius };
  if (type === "arc") return { ...base, type, center: point(0, 0), radius, startAngle: 300, endAngle: 180 };
  if (type === "positive-bulge" || type === "negative-bulge") {
    const direction = type === "positive-bulge" ? 1 : -1;
    return {
      ...base, type: direction === 1 ? "lwpolyline" : "polyline", closed: false,
      vertices: [
        { ...point(radius * direction, 0), bulge: direction },
        { ...point(-radius * direction, 0), bulge: 0 }
      ]
    };
  }
  const counterClockwise = type !== "clockwise-hatch";
  return {
    ...base, type: "hatch", loops: [{ type: "edges", edges: [{
      type: "arc", center: point(0, 0), radius,
      startAngle: counterClockwise ? 0 : 180,
      endAngle: counterClockwise ? (type === "full-hatch" ? 360 : 180) : 0,
      counterClockwise
    }] }]
  };
}

describe("detectCadRegions", () => {
  describe.each([
    { name: "direct", rotation: 0, scaleX: 1, scaleY: 1 },
    { name: "rotated INSERT", rotation: 37, scaleX: 1, scaleY: 1 },
    { name: "reflected INSERT", rotation: 23, scaleX: -1, scaleY: 1 },
    { name: "nonuniform INSERT", rotation: 23, scaleX: -2, scaleY: 0.5 }
  ])("sparse geometry pairs ($name)", ({ name, rotation, scaleX, scaleY }) => {
    it.each(["circle", "arc"] as const)("separates concentric large %ss with a wide gap", type => {
      const curves: NormalizedCadEntity[] = [3_000_000, 2_900_000].map((radius, index) => ({
        type, sourceEntityId: `concentric-${index}`, layer: "WALL", center: point(0, 0), radius,
        ...(type === "arc" ? { startAngle: 10, endAngle: 170 } : {})
      } as NormalizedCadEntity));
      const drawing = document([
        ...(name === "direct" ? curves : [{
          type: "insert" as const, sourceEntityId: "pair-insert", layer: "0", blockName: "PAIR",
          position: point(120, -70), rotation, scale: { x: scaleX, y: scaleY, z: 1 }, attributes: []
        }]),
        ...rectangle("small-distant-detail", 10_000_000, 10_000_000, 10, 10)
      ], name === "direct" ? [] : [{ name: "PAIR", basePoint: point(0, 0), entities: curves }]);
      let work = 0;
      const options = {
        maxSpatialBuckets: 128,
        checkBudget: () => {
          if (++work > 10_000) throw new Error("Sparse pair work budget exhausted");
        }
      };
      const detected = detectCadRegions(drawing, options);
      expect(detected.regions.map(region => region.primitiveCount).sort((a, b) => a - b)).toEqual([1, 1, 4]);
      work = 0;
      expect(detectCadRegions({ ...drawing, entities: [...drawing.entities].reverse(),
        blocks: drawing.blocks.map(block => ({ ...block, entities: [...block.entities].reverse() }))
      }, options)).toEqual(detected);
    });
  });

  it.each([
    { name: "crossing circles", offset: 3_000_000, gap: 0, count: 2 },
    { name: "tangent circles", offset: 6_000_000, gap: 0, count: 2 },
    { name: "nearby circles", offset: 6_000_020, gap: 0, count: 2 },
    { name: "nearby concentric circles", offset: 0, gap: 20, count: 2 },
    { name: "separated circles", offset: 6_001_000, gap: 0, count: 3 }
  ])("preserves actual sparse contact for $name", ({ offset, gap, count }) => {
    const detected = detectCadRegions(document([
      { type: "circle", sourceEntityId: "first", layer: "0", center: point(0, 0), radius: 3_000_000 },
      { type: "circle", sourceEntityId: "second", layer: "0", center: point(offset, 0), radius: 3_000_000 - gap },
      ...rectangle("scale-detail", 10_000_000, 10_000_000, 10, 10)
    ]), { maxSpatialBuckets: 128 });
    expect(detected.regions).toHaveLength(count);
    expect(detected.regions.map(region => region.primitiveCount).sort((a, b) => a - b))
      .toEqual(count === 2 ? [2, 4] : [1, 1, 4]);
  });

  it.each([
    { name: "interior", start: point(-2_500_000, 500_000), end: point(500_000, -2_500_000), counts: [1, 1, 4] },
    { name: "crossing", start: point(-4_000_000, 0), end: point(4_000_000, 0), counts: [2, 4] },
    { name: "tangent", start: point(-1_000_000, 3_000_000), end: point(1_000_000, 3_000_000), counts: [2, 4] }
  ])("uses actual geometry for an $name sparse line and circle", ({ start, end, counts }) => {
    const entities: NormalizedCadEntity[] = [
      { type: "circle", sourceEntityId: "circle", layer: "0", center: point(0, 0), radius: 3_000_000 },
      { type: "line", sourceEntityId: "line", layer: "0", start, end },
      ...rectangle("scale-detail", 10_000_000, 10_000_000, 10, 10)
    ];
    const detected = detectCadRegions(document(entities), { maxSpatialBuckets: 128 });
    expect(detected.regions.map(region => region.primitiveCount).sort((a, b) => a - b)).toEqual(counts);
    expect(detectCadRegions(document([...entities].reverse()), { maxSpatialBuckets: 128 })).toEqual(detected);
  });

  it("retains short hatch edges when comparing two sparse records", () => {
    const detected = detectCadRegions(document([
      { type: "hatch", sourceEntityId: "mixed-hatch", layer: "0", loops: [{ type: "edges", edges: [
        { type: "arc", center: point(0, 0), radius: 3_000_000, startAngle: 0, endAngle: 180, counterClockwise: true },
        { type: "line", start: point(0, 0), end: point(10, 0) }
      ] }] },
      { type: "line", sourceEntityId: "short-edge-contact", layer: "0", start: point(5, -1_000_000), end: point(5, 1_000_000) },
      ...rectangle("scale-detail", 10_000_000, 10_000_000, 10, 10)
    ]), { maxSpatialBuckets: 128 });
    expect(detected.regions.map(region => region.primitiveCount).sort((a, b) => a - b)).toEqual([2, 4]);
  });

  it("charges already-connected sparse candidate pairs to the bounded work budget", () => {
    const repeated: NormalizedCadEntity[] = Array.from({ length: 700 }, (_, index) => ({
      type: "line",
      sourceEntityId: `repeated-sparse-${index}`,
      layer: "0",
      start: point(0, 0),
      end: point(3_000_000, 0)
    }));
    const scaleAnchors: NormalizedCadEntity[] = Array.from({ length: 701 }, (_, index) => ({
      type: "line",
      sourceEntityId: `scale-anchor-${index}`,
      layer: "0",
      start: point(10_000_000, 0),
      end: point(10_000_001, 0)
    }));

    expect(() => detectCadRegions(document([...repeated, ...scaleAnchors]), { maxSpatialBuckets: 128 }))
      .toThrow(/sparse proximity work limit/i);
  });

  describe.each([false, true])("huge curves (transformed INSERT: %s)", transformed => {
    it.each(["circle", "arc", "positive-bulge", "negative-bulge", "hatch", "clockwise-hatch", "full-hatch"])(
      "bounds %s indexing before tessellation without losing contact or proximity",
      type => {
        const rotation = 23 * Math.PI / 180;
        const worldPoint = (angle: number, radius: number) => {
          const x = radius * Math.cos(angle * Math.PI / 180);
          const y = radius * Math.sin(angle * Math.PI / 180);
          return transformed
            ? point(120 - 2 * x * Math.cos(rotation) - 0.5 * y * Math.sin(rotation),
              -70 - 2 * x * Math.sin(rotation) + 0.5 * y * Math.cos(rotation))
            : point(x, y);
        };
        const touching = worldPoint(37.123, 3_000_000);
        const nearby = worldPoint(71.789, 3_000_020);
        const distant = worldPoint(97.321, 2_990_000);
        const curve = hugeCurve(type);
        const drawing = document([
          transformed ? {
            type: "insert", sourceEntityId: "curve-insert", layer: "0", blockName: "CURVE",
            position: point(120, -70), rotation: 23, scale: { x: -2, y: 0.5, z: 1 }, attributes: []
          } : curve,
          ...rectangle("touching", touching.x - 5, touching.y - 5, 10, 10),
          ...rectangle("nearby", nearby.x - 5, nearby.y - 5, 10, 10),
          ...rectangle("distant-inside-bounds", distant.x - 5, distant.y - 5, 10, 10)
        ], transformed ? [{ name: "CURVE", basePoint: point(0, 0), entities: [curve] }] : []);

        const detected = detectCadRegions(drawing);
        expect(detected.regions.map(region => region.primitiveCount).sort((a, b) => a - b)).toEqual([4, 9]);
        expect(detected.excludedPrimitiveCount).toBe(0);
        let work = 0;
        // A stricter bucket/work budget catches cell enumeration even when it
        // happens to finish below the production 200k bucket limit.
        expect(detectCadRegions({ ...drawing, entities: [...drawing.entities].reverse() }, {
          maxSpatialBuckets: 128,
          checkBudget: () => {
            if (++work > 1_000) throw new Error("Huge curve work budget exhausted");
          }
        })).toEqual(detected);
      }
    );
  });

  it.each(["arc", "positive-bulge", "negative-bulge", "hatch", "clockwise-hatch"])(
    "does not join a detail on the omitted sweep of a huge %s",
    type => {
      const detected = detectCadRegions(document([
        hugeCurve(type),
        ...rectangle("excluded-sweep", -5, -3_000_005, 10, 10),
        ...rectangle("endpoint", 2_999_995, -5, 10, 10)
      ]), { maxSpatialBuckets: 128 });

      expect(detected.regions.map(region => region.primitiveCount).sort((a, b) => a - b)).toEqual([4, 5]);
    }
  );

  it("separates a floor plan, title block, and detail drawing across empty model-space gaps", () => {
    const entities = [
      ...rectangle("floor", 0, 0, 1_600, 900),
      { type: "text", sourceEntityId: "floor-label", layer: "TEXT", position: point(100, 100), rotation: 0, height: 40, text: "B2" } as const,
      ...rectangle("title", 100_000, 0, 800, 400),
      { type: "text", sourceEntityId: "title-label", layer: "TEXT", position: point(100_050, 50), rotation: 0, height: 20, text: "TITLE" } as const,
      ...rectangle("detail", 0, 100_000, 500, 500)
    ];

    const { regions } = detectCadRegions(document(entities), {
      lightCandidates: [
        { sourceEntityId: "floor-candidate", position: point(800, 450) },
        { sourceEntityId: "title-candidate", position: point(100_200, 200) }
      ]
    });

    expect(regions.map(({ bounds, primitiveCount, textCount, lightCandidateCount, area }) => ({
      bounds, primitiveCount, textCount, lightCandidateCount, area
    }))).toEqual([
      {
        bounds: { minX: 0, minY: 0, maxX: 1_600, maxY: 900 },
        primitiveCount: 5,
        textCount: 1,
        lightCandidateCount: 1,
        area: 1_440_000
      },
      {
        bounds: { minX: 0, minY: 100_000, maxX: 500, maxY: 100_500 },
        primitiveCount: 4,
        textCount: 0,
        lightCandidateCount: 0,
        area: 250_000
      },
      {
        bounds: { minX: 100_000, minY: 0, maxX: 100_800, maxY: 400 },
        primitiveCount: 5,
        textCount: 1,
        lightCandidateCount: 1,
        area: 320_000
      }
    ]);
    expect(regions.map(region => region.regionId)).toEqual(
      expect.arrayContaining(regions.map(region => expect.stringMatching(/^region-[a-f0-9]{24}$/)))
    );

    const reversed = detectCadRegions(document([...entities].reverse()), {
      lightCandidates: [
        { sourceEntityId: "title-candidate", position: point(100_200, 200) },
        { sourceEntityId: "floor-candidate", position: point(800, 450) }
      ]
    });
    expect(reversed.regions).toEqual(regions);
    expect(reversed.excludedPrimitiveCount).toBe(0);
  });

  it("excludes isolated point noise without changing meaningful region IDs or primitive counts", () => {
    const symbol = rectangle("symbol", 0, 0, 100, 100);
    const entities: NormalizedCadEntity[] = [
      ...rectangle("floor", 0, 0, 1_000, 600),
      {
        type: "insert", sourceEntityId: "symbol-occurrence", layer: "DETAIL", blockName: "SYMBOL",
        position: point(100_000, 100_000), rotation: 0, scale: { x: 1, y: 1, z: 1 }, attributes: []
      },
      ...rectangle("two-entity-detail-a", 200_000, 0, 50, 50).slice(0, 2),
      ...rectangle("two-entity-detail-b", 200_050, 0, 50, 50).slice(2),
      { type: "point", sourceEntityId: "noise", layer: "0", position: point(1_000_000, 1_000_000) }
    ];

    const detected = detectCadRegions(document(entities, [{
      name: "SYMBOL",
      basePoint: point(0, 0),
      entities: symbol
    }]));
    const withoutNoise = detectCadRegions(document(entities.slice(0, -1), [{
      name: "SYMBOL",
      basePoint: point(0, 0),
      entities: symbol
    }]));

    const { regions } = detected;
    expect(detected.excludedPrimitiveCount).toBe(1);
    expect(withoutNoise.excludedPrimitiveCount).toBe(0);
    expect(regions).toHaveLength(3);
    expect(regions.map(region => region.primitiveCount)).toEqual([4, 4, 4]);
    expect(regions.map(region => region.regionId)).toEqual(withoutNoise.regions.map(region => region.regionId));
    expect(regions.map(region => region.bounds)).toEqual([
      { minX: 0, minY: 0, maxX: 1_000, maxY: 600 },
      { minX: 100_000, minY: 100_000, maxX: 100_100, maxY: 100_100 },
      { minX: 200_000, minY: 0, maxX: 200_100, maxY: 50 }
    ]);
    expect(regions.reduce((sum, region) => sum + region.primitiveCount, 0)).toBe(entities.length + symbol.length - 2);
  });

  it("connects edge details through uniformly indexed perimeter buckets of a large outline", () => {
    const outline: NormalizedCadEntity = {
      type: "lwpolyline",
      sourceEntityId: "large-outline",
      layer: "WALL",
      closed: true,
      vertices: [
        { ...point(0, 0), bulge: 0 },
        { ...point(10_000, 0), bulge: 0 },
        { ...point(10_000, 10_000), bulge: 0 },
        { ...point(0, 10_000), bulge: 0 }
      ]
    };
    const entities = [
      outline,
      ...rectangle("top-edge-detail", 4_995, 9_995, 10, 10),
      ...rectangle("right-edge-detail", 9_995, 4_995, 10, 10)
    ];

    const { regions } = detectCadRegions(document(entities));

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      bounds: { minX: 0, minY: 0, maxX: 10_005, maxY: 10_005 },
      primitiveCount: 9
    });
  });

  it("connects a small detail touching an arbitrary point of a very large outline", () => {
    const outline: NormalizedCadEntity = {
      type: "lwpolyline",
      sourceEntityId: "million-unit-outline",
      layer: "WALL",
      closed: true,
      vertices: [
        { ...point(0, 0), bulge: 0 },
        { ...point(1_000_000, 0), bulge: 0 },
        { ...point(1_000_000, 1_000_000), bulge: 0 },
        { ...point(0, 1_000_000), bulge: 0 }
      ]
    };

    const { regions } = detectCadRegions(document([
      outline,
      ...rectangle("arbitrary-top-detail", 1_995, 999_995, 10, 10)
    ]));

    expect(regions).toHaveLength(1);
    expect(regions[0].primitiveCount).toBe(5);
  });

  it("uses bounded sparse matching for a huge outline while separating a distant detail", () => {
    const outline: NormalizedCadEntity = {
      type: "lwpolyline",
      sourceEntityId: "three-million-outline",
      layer: "WALL",
      closed: true,
      vertices: [
        { ...point(0, 0), bulge: 0 },
        { ...point(3_000_000, 0), bulge: 0 },
        { ...point(3_000_000, 3_000_000), bulge: 0 },
        { ...point(0, 3_000_000), bulge: 0 }
      ]
    };

    const { regions } = detectCadRegions(document([
      outline,
      ...rectangle("touching-detail", 1_234_495, 2_999_995, 10, 10),
      ...rectangle("distant-detail", 4_000_000, 4_000_000, 10, 10)
    ]));

    expect(regions).toHaveLength(2);
    expect(regions.map(region => region.primitiveCount)).toEqual([5, 4]);
  });

  it("keeps distant children of one wrapper insert in separate spatial regions", () => {
    const drawing = document([{
      type: "insert",
      sourceEntityId: "xref-wrapper",
      layer: "XREF",
      blockName: "WRAPPER",
      position: point(0, 0),
      rotation: 0,
      scale: { x: 1, y: 1, z: 1 },
      attributes: []
    }], [{
      name: "WRAPPER",
      basePoint: point(0, 0),
      entities: [
        ...rectangle("near-child", 0, 0, 100, 100),
        ...rectangle("distant-child", 1_000_000, 1_000_000, 100, 100)
      ]
    }]);
    const { regions } = detectCadRegions(drawing, {
      lightCandidates: [{ sourceEntityId: "xref-wrapper", position: point(1_000_050, 1_000_050) }]
    });

    expect(regions).toHaveLength(2);
    expect(regions.map(region => region.primitiveCount)).toEqual([4, 4]);
    expect(regions.map(region => region.lightCandidateCount)).toEqual([0, 1]);
  });

  it("assigns a candidate by insert occurrence when its base point is outside the expanded geometry", () => {
    const detected = detectCadRegions(document([
      ...rectangle("main", 0, 0, 1_000, 600),
      {
        type: "insert",
        sourceEntityId: "light-insert",
        layer: "LIGHT",
        blockName: "OFFSET_LIGHT",
        position: point(100_000, 100_000),
        rotation: 0,
        scale: { x: 1, y: 1, z: 1 },
        attributes: []
      }
    ], [{
      name: "OFFSET_LIGHT",
      basePoint: point(1_000, 1_000),
      entities: rectangle("offset-light", 0, 0, 100, 100)
    }]), {
      lightCandidates: [{ sourceEntityId: "light-insert", position: point(100_000, 100_000) }]
    });

    expect(detected.regions.map(region => region.lightCandidateCount)).toEqual([0, 1]);
    expect(detected.regions[1].bounds).toEqual({ minX: 99_000, minY: 99_000, maxX: 99_100, maxY: 99_100 });
    expect((detected as any).candidateRegionAssignments).toEqual([{
      sourceEntityId: "light-insert",
      regionId: detected.regions[1].regionId
    }]);
  });

  it("uses occurrence identity for overlapping bounds and rejects an ambiguous spatial fallback", () => {
    const largeOutline = (sourceEntityId: string, halfSize: number): NormalizedCadEntity => ({
      type: "lwpolyline",
      sourceEntityId,
      layer: "WALL",
      closed: true,
      vertices: [
        { ...point(-halfSize, -halfSize), bulge: 0 },
        { ...point(halfSize, -halfSize), bulge: 0 },
        { ...point(halfSize, halfSize), bulge: 0 },
        { ...point(-halfSize, halfSize), bulge: 0 }
      ]
    });
    const insert = (sourceEntityId: string, blockName: string): NormalizedCadEntity => ({
      type: "insert",
      sourceEntityId,
      layer: "0",
      blockName,
      position: point(5_000, 5_000),
      rotation: 0,
      scale: { x: 1, y: 1, z: 1 },
      attributes: []
    });
    const drawing = document([
      insert("outer-insert", "OUTER"),
      insert("inner-insert", "INNER")
    ], [
      {
        name: "OUTER",
        basePoint: point(0, 0),
        entities: [largeOutline("outer-outline", 5_000), ...rectangle("outer-edge", -5, 4_995, 10, 10)]
      },
      {
        name: "INNER",
        basePoint: point(0, 0),
        entities: [largeOutline("inner-outline", 3_000), ...rectangle("inner-edge", -5, 2_995, 10, 10)]
      }
    ]);

    const detected = detectCadRegions(drawing, {
      lightCandidates: [{ sourceEntityId: "outer-insert", position: point(5_000, 5_000) }]
    });

    expect(detected.regions).toHaveLength(2);
    expect(detected.regions.map(region => region.lightCandidateCount)).toEqual([1, 0]);
    expect(detected.candidateRegionAssignments).toEqual([{
      sourceEntityId: "outer-insert",
      regionId: detected.regions[0].regionId
    }]);
    expect(() => detectCadRegions(drawing, {
      lightCandidates: [{ sourceEntityId: "unknown-candidate", position: point(5_000, 5_000) }]
    })).toThrow(/exactly one detected region/i);
    expect(() => detectCadRegions(drawing, {
      lightCandidates: [{ sourceEntityId: "unknown-candidate", position: point(100_000, 100_000) }]
    })).toThrow(/exactly one detected region/i);
  });

  it("excludes 150,000 zero-area singleton points while retaining meaningful geometry", () => {
    const entities: NormalizedCadEntity[] = [{
      type: "circle",
      sourceEntityId: "meaningful-anchor",
      layer: "0",
      center: point(0, 0),
      radius: 10
    }, ...Array.from({ length: 150_000 }, (_, index): NormalizedCadEntity => ({
      type: "point",
      sourceEntityId: `component-${index}`,
      layer: "0",
      position: point((index + 1) * 1_000, 0)
    }))];

    const detected = detectCadRegions(document(entities), { maxSpatialBuckets: 600_000 });

    expect(detected.regions).toHaveLength(1);
    expect(detected.regions[0].primitiveCount).toBe(1);
    expect(detected.excludedPrimitiveCount).toBe(150_000);
  }, 60_000);

  it("retains meaningful isolated geometry and rejects region counts above the explicit limit", () => {
    const isolated = Array.from({ length: 3 }, (_, index): NormalizedCadEntity => ({
      type: "circle",
      sourceEntityId: `meaningful-${index}`,
      layer: "0",
      center: point(index * 100, 0),
      radius: 1
    }));
    expect(detectCadRegions(document(isolated)).regions.map(region => region.primitiveCount)).toEqual([1, 1, 1]);

    const overLimit = Array.from({ length: CAD_MAX_DETECTED_REGIONS + 1 }, (_, index): NormalizedCadEntity => ({
      type: "circle",
      sourceEntityId: `over-limit-${index}`,
      layer: "0",
      center: point(index * 100, 0),
      radius: 1
    }));
    expect(() => detectCadRegions(document(overLimit), { maxSpatialBuckets: 100_000 }))
      .toThrow(/region count limit/i);
  }, 30_000);
});
