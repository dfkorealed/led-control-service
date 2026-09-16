import type { NormalizedCadDocument } from "./cad-types";
import { renderCadDocumentSvg } from "./cad-svg-renderer";

const document: NormalizedCadDocument = {
  version: 1,
  bounds: { minX: 0, minY: 0, maxX: 12, maxY: 8 },
  blocks: [{
    name: "LED<&>", basePoint: { x: 0, y: 0, z: 0 },
    entities: [{ type: "circle", sourceEntityId: "block-circle", layer: "SYMBOL", center: { x: 0, y: 0, z: 0 }, radius: 1 }]
  }],
  entities: [
    { type: "line", sourceEntityId: "line-1", layer: "WALL", start: { x: 0, y: 0, z: 0 }, end: { x: 12, y: 8, z: 0 } },
    { type: "text", sourceEntityId: "text-1", layer: "NOTE", position: { x: 2, y: 3, z: 0 }, rotation: 0, height: 1, text: "<script>alert('x') & \"y\"</script>" },
    { type: "insert", sourceEntityId: "insert-1", layer: "LIGHT<&>", blockName: "LED<&>", position: { x: 10, y: 5, z: 0 }, rotation: 30, scale: { x: 2, y: 2, z: 1 } }
  ]
};

describe("CAD SVG renderer", () => {
  it("renders one self-contained SVG with a normalized viewport and expanded blocks", () => {
    const svg = renderCadDocumentSvg(document);

    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg.match(/<\/svg>/g)).toHaveLength(1);
    expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(svg).toContain('data-source-entity-id="insert-1:block-circle"');
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(svg).not.toMatch(/(?:href|src)=|<image|<foreignObject|@import/i);
  });

  it("XML-escapes every user-controlled layer, block and text value", () => {
    const svg = renderCadDocumentSvg(document);
    expect(svg).toContain("&lt;script&gt;alert(&apos;x&apos;) &amp; &quot;y&quot;&lt;/script&gt;");
    expect(svg).toContain("LIGHT&lt;&amp;&gt;");
    expect(svg).toContain("LED&lt;&amp;&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("replaces XML-forbidden controls and isolated surrogate code units", () => {
    const hostile = structuredClone(document);
    const text = hostile.entities[1];
    if (text.type !== "text") throw new Error("Expected text fixture");
    text.text = "safe\u0000\uD800tail";

    const svg = renderCadDocumentSvg(hostile);
    expect(svg).toContain("safe\uFFFD\uFFFDtail");
    expect(svg).not.toContain("\u0000");
    expect(svg).not.toContain("\uD800");
  });

  it("fails closed when expansion or output exceeds configured limits", () => {
    expect(() => renderCadDocumentSvg(document, { maxRenderedEntities: 2 })).toThrow(/rendered entity.*limit/i);
    expect(() => renderCadDocumentSvg(document, { maxOutputBytes: 64 })).toThrow(/output.*limit/i);
  });
});
