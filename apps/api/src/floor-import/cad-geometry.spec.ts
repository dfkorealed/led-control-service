import { computeCadBounds, iterateCadDocumentExpansion } from "./cad-geometry";
import { detectCadRegions } from "./cad-region-detector";
import { parseAsciiDxf } from "./dxf-document-parser";

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
