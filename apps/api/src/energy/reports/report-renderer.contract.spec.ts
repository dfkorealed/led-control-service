import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import { expectedManifest, reportFixture, visualReportFixture, expectedVisualIds } from "./report-renderer.test-support";
import { buildReportVisuals } from "./report-visual-model";
import { renderReportVisual } from "./report-chart-image.renderer";
import { reportBlocks } from "./report-renderer";
import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot } from "./energy-report-document.builder";

describe("PDF report content contract", () => {
  it("embeds all eight ordered source PNG digests and retains scalar content", async () => {
    const document = visualReportFixture();
    const sources = await Promise.all(buildReportVisuals(document).map(renderReportVisual));
    expect(sources.map(visual => visual.id)).toEqual(expectedVisualIds);
    const expected = sources.map(({ id, sha256, width, height }) => ({ id, sha256, width, height }));
    const pdf = await new PdfEnergyReportRenderer().render(document, sources);
    expect(pdf.visuals).toEqual(expected);
    expect(pdf.manifest).toEqual(reportBlocks(document).flatMap(block => block.groups.flat()));
    expect(pdf.bytes.length).toBeLessThan(25 * 1024 * 1024);
  }, 60000);

  it("rejects missing, reordered, or corrupted source images", async () => {
    const document = visualReportFixture();
    const sources = await Promise.all(buildReportVisuals(document).map(renderReportVisual));
    const renderer = new PdfEnergyReportRenderer();
    await expect(renderer.render(document, sources.slice(1))).rejects.toThrow(/Missing report chart/);
    await expect(renderer.render(document, [...sources].reverse())).rejects.toThrow(/Invalid report chart source/);
    await expect(renderer.render(document, sources.map((source, index) => index === 0 ? { ...source, sha256: "0".repeat(64) } : source))).rejects.toThrow(/Invalid report chart source/);
  }, 60000);

  it("preserves v1 scalar bytes and excludes internal v2 instructions from the PDF manifest", async () => {
    const legacy = reportFixture();
    expect(JSON.stringify(reportBlocks(legacy).flatMap(block => block.groups.flat()))).toBe(JSON.stringify(expectedManifest(legacy)));
    const siteId = "20000000-0000-4000-8000-000000000001";
    const data: EnergyReportDataSnapshot = { schemaVersion: 2, capturedAt: "2026-09-11T00:00:00.000Z",
      site: { id: siteId, name: "현장", timeZone: "UTC", tariffKwhRate: "160" }, comparisonRange: { from: "2026-09-09", to: "2026-09-09" }, fixtures: [] };
    const document = new EnergyReportDocumentBuilder().build(legacy.reportId, { scope: "site", identityId: siteId, format: "pdf", from: "2026-09-10", to: "2026-09-10" }, data);
    const expected = expectedManifest(document).filter(token => !token.path.startsWith("calculationBasis.") && !/\.(visualization|rowIds)\.|\.source$/.test(token.path));
    expect(reportBlocks(document).flatMap(block => block.groups.flat())).toEqual(expected);
    expect((await new PdfEnergyReportRenderer().render(document)).manifest).toEqual(expected);
  }, 60000);

  it.each(["한글", "café e\u0301 a\u0301", "한글 💡 e\u0301 😀", "prefix " + "한글".normalize("NFD")])("round-trips supported complete text runs (%s)", async text => {
    const document = reportFixture();
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }]; document.sections = [];
    expect((await new PdfEnergyReportRenderer().render(document)).manifest).toEqual(expectedManifest(document));
  });

  it.each(["한글".normalize("NFD"), "A".repeat(40) + " " + "한글".normalize("NFD").repeat(3)])("rejects composed NFD shaping before writing a PDF", async text => {
    const document = reportFixture();
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }]; document.sections = [];
    await expect(new PdfEnergyReportRenderer().render(document)).rejects.toThrow(/Unsupported report/);
  });

  it("preserves Korean, emoji and representative Unicode through actual glyph extraction", async () => {
    const document = reportFixture();
    const text = "조명 💡 · café Ω Ж 東京 😀 · e\u0301 ⚡ 👩 🔧";
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }];
    document.sections = [];
    const pdf = await new PdfEnergyReportRenderer().render(document);
    expect(pdf.manifest).toEqual(expectedManifest(document));
  });

  it("rejects an unsupported scalar", async () => {
    const document = reportFixture();
    document.metadata = [{ label: "Unicode", value: "\u{10FFFF}", displayValue: "\u{10FFFF}" }];
    document.sections = [];
    await expect(new PdfEnergyReportRenderer().render(document)).rejects.toThrow(/Unsupported report character/);
  });

  it.each(["\u00A0", "\uFE0F", "\u200D"])("rejects non-roundtrippable glyph aliases and join controls (%j)", async text => {
    const document = reportFixture();
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }]; document.sections = [];
    await expect(new PdfEnergyReportRenderer().render(document)).rejects.toThrow(/Unsupported report character/);
  });

  it("preserves CRLF strings without changing the immutable document", async () => {
    const document = reportFixture();
    document.metadata = [{ label: "줄바꿈", value: "첫째 줄\r\n둘째 줄", displayValue: "첫째 줄\r\n둘째 줄" }];
    document.sections = [];
    const original = structuredClone(document);
    const result = await new PdfEnergyReportRenderer().render(document);
    expect(result.manifest).toEqual(expectedManifest(document));
    expect(document).toEqual(original);
    expect(result.visuals).toEqual([]);
  });

  it("extracts every ordered scalar from the generated PDF and preserves the input", async () => {
    const document = reportFixture();
    const original = structuredClone(document);
    const pdf = await new PdfEnergyReportRenderer().render(document);
    expect(pdf.manifest).toEqual(expectedManifest(document));
    expect(document).toEqual(original);
  }, 60000);

  it("preserves an empty raw string and a document with no sections", async () => {
    const document = reportFixture();
    document.metadata = [{ label: "빈 원시값", value: "", displayValue: "—" }];
    document.sections = [];
    const pdf = await new PdfEnergyReportRenderer().render(document);
    expect(pdf.manifest).toEqual(expectedManifest(document));
  });
});
