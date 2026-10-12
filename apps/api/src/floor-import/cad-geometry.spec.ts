import { computeCadBounds, dimensionMatrix, iterateCadDocumentExpansion, iterateCadGeometryExpansion, transformPoint } from "./cad-geometry";
import { detectCadRegions } from "./cad-region-detector";
import { parseAsciiDxf } from "./dxf-document-parser";
import type { CadPoint, NormalizedCadDocument, NormalizedCadEntity } from "./cad-types";

const point = (x: number, y: number): CadPoint => ({ x, y, z: 0 });
const dimension: Extract<NormalizedCadEntity, { type: "dimension" }> = {
  type: "dimension", sourceEntityId: "A8F", layer: "0", blockName: "*D3",
  definitionPoint: point(2231.746952437386, 635.0007176507261), blockPosition: point(0, 0),
  textPosition: point(2202.646952437386, 650.1371432987479),
  extensionStart: point(2173.546952437386, 593.6405588876041),
  extensionEnd: point(2231.746952437386, 593.6405588876041), rotation: 0, text: "58"
};
const dimensionLine: Extract<NormalizedCadEntity, { type: "line" }> = {
  type: "line", sourceEntityId: "1026", layer: "0",
  start: point(2176.046952437386, 635.0007176507261), end: point(2229.246952437386, 635.0007176507261)
};

describe("DIMENSION picture coordinates", () => {
  const document: Pick<NormalizedCadDocument, "blocks" | "entities"> = {
    blocks: [{ name: "*D3", basePoint: point(0, 0), entities: [dimensionLine] }], entities: [dimension]
  };

  it.each([iterateCadDocumentExpansion, iterateCadGeometryExpansion])("does not add the WCS definition point to anonymous block geometry (%#)", expand => {
    const expanded = [...expand(document, { maxRenderedEntities: 10 })].filter(value => value !== null);
    expect(expanded).toHaveLength(1);
    expect(transformPoint(expanded[0]!.matrix, dimensionLine.start)).toEqual(dimensionLine.start);
    expect(computeCadBounds(expanded)).toEqual({ minX: 2176.046952437386, minY: 635.0007176507261,
      maxX: 2229.246952437386, maxY: 635.0007176507261 });
  });

  it("applies only the clone insertion offset minus block base", () => {
    const matrix = dimensionMatrix({ ...dimension, blockPosition: point(5, -10) }, point(2, 3));
    expect(transformPoint(matrix, point(2, 3))).toEqual(point(5, -10));
    expect(transformPoint(matrix, point(12, 3))).toEqual(point(15, -10));
  });

  it.each([iterateCadDocumentExpansion, iterateCadGeometryExpansion])("preserves the parent INSERT rotation and reflected nonuniform scale (%#)", expand => {
    const nested = {
      blocks: [...document.blocks, { name: "PARENT", basePoint: point(0, 0), entities: [dimension] }],
      entities: [{ type: "insert" as const, sourceEntityId: "I", layer: "0", blockName: "PARENT", position: point(100, 200),
        rotation: 90, scale: { x: -2, y: 3, z: 1 }, attributes: [] }]
    };
    const expanded = [...expand(nested, { maxRenderedEntities: 10 })].filter(value => value !== null);
    const start = transformPoint(expanded[0]!.matrix, dimensionLine.start);
    expect(start.x).toBeCloseTo(-1805.0021529521783, 8);
    expect(start.y).toBeCloseTo(-4152.093904874772, 8);
  });
});

describe("MTEXT visible bounds", () => {
  it("measures displayed characters rather than font control syntax", () => {
    const text: Extract<NormalizedCadEntity, { type: "mtext" | "text" }> = {
      type: "mtext", sourceEntityId: "CE6", layer: "0", position: point(0, 0), rotation: 0, height: 30,
      text: "{\\fGulim|b0|i0|c129|p50;디에프코리아}"
    };
    const expand = (entity: typeof text) => iterateCadGeometryExpansion({ blocks: [], entities: [entity] }, { maxRenderedEntities: 10 });
    expect(computeCadBounds(expand(text))).toEqual(computeCadBounds(expand({ ...text, text: "디에프코리아" })));
  });
});

describe("ELLIPSE source bounds", () => {
  it("retains rotated nonuniform reflected block extrema in parser and region bounds", () => {
    const fixture = [
      "0", "SECTION", "2", "BLOCKS", "0", "BLOCK", "2", "B", "10", "0", "20", "0",
      "0", "ELLIPSE", "5", "E", "10", "0", "20", "0", "11", "4", "21", "3", "40", "0.4",
      "41", "0", "42", String(2 * Math.PI), "0", "ENDBLK", "0", "ENDSEC",
      "0", "SECTION", "2", "ENTITIES", "0", "INSERT", "5", "I", "2", "B", "10", "10", "20", "20",
      "41", "-2", "42", "3", "50", "30", "0", "ENDSEC", "0", "EOF", ""
    ].join("\n");
    const document = parseAsciiDxf(fixture);
    const computed = computeCadBounds(iterateCadDocumentExpansion(document, { maxRenderedEntities: 10 }));
    const cosine = Math.cos(Math.PI / 6), sine = Math.sin(Math.PI / 6);
    const extentX = Math.hypot(-8 * cosine - 9 * sine, 2.4 * cosine - 4.8 * sine);
    const extentY = Math.hypot(-8 * sine + 9 * cosine, 2.4 * sine + 4.8 * cosine);
    expect(computed.minX).toBeCloseTo(10 - extentX, 10);
    expect(computed.maxX).toBeCloseTo(10 + extentX, 10);
    expect(computed.minY).toBeCloseTo(20 - extentY, 10);
    expect(computed.maxY).toBeCloseTo(20 + extentY, 10);
    const region = detectCadRegions(document).regions[0];
    for (const key of Object.keys(computed) as Array<keyof typeof computed>) {
      expect(document.bounds[key]).toBeCloseTo(computed[key], 5);
      expect(region.bounds[key]).toBeCloseTo(computed[key], 5);
    }
    expect(region.primitiveCount).toBe(1);
    expect(region.lightCandidateCount).toBe(0);
  });
});
