import { ExcelEnergyReportRenderer } from "./excel-energy-report.renderer";
import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import { expectedManifest, reportFixture } from "./report-renderer.test-support";
import { reportBlocks } from "./report-renderer";
import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot } from "./energy-report-document.builder";

describe("identical report content contract", () => {
  it("preserves v1 scalar bytes and excludes internal v2 instructions from both serialized manifests", async () => {
    const legacy = reportFixture();
    expect(JSON.stringify(reportBlocks(legacy).flatMap(block => block.groups.flat()))).toBe(JSON.stringify(expectedManifest(legacy)));
    const siteId = "20000000-0000-4000-8000-000000000001";
    const data: EnergyReportDataSnapshot = { schemaVersion: 2, capturedAt: "2026-09-11T00:00:00.000Z",
      site: { id: siteId, name: "현장", timeZone: "UTC", tariffKwhRate: "160" }, comparisonRange: { from: "2026-09-09", to: "2026-09-09" }, fixtures: [] };
    const document = new EnergyReportDocumentBuilder().build(legacy.reportId, { scope: "site", identityId: siteId, format: "pdf", from: "2026-09-10", to: "2026-09-10" }, data);
    const expected = expectedManifest(document).filter(token => !token.path.startsWith("calculationBasis.") && !/\.(visualization|rowIds)\.|\.source$/.test(token.path));
    expect(reportBlocks(document).flatMap(block => block.groups.flat())).toEqual(expected);
    for (const Renderer of [ExcelEnergyReportRenderer, PdfEnergyReportRenderer]) expect((await new Renderer().render(document)).manifest).toEqual(expected);
  }, 60000);
  it.each(["한글", "café e\u0301 a\u0301", "한글 💡 e\u0301 😀", "prefix " + "한글".normalize("NFD")])("round-trips supported complete text runs in both actual formats (%s)", async text => {
    const document = reportFixture();
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }]; document.sections = [];
    for (const Renderer of [ExcelEnergyReportRenderer, PdfEnergyReportRenderer]) {
      expect((await new Renderer().render(document)).manifest).toEqual(expectedManifest(document));
    }
  });
  it("rejects composed NFD shaping before either renderer writes a file", async () => {
    const document = reportFixture(); const text = "한글".normalize("NFD");
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }]; document.sections = [];
    for (const Renderer of [ExcelEnergyReportRenderer, PdfEnergyReportRenderer]) {
      await expect(new Renderer().render(document)).rejects.toThrow(/Unsupported report/);
    }
  });
  it("rejects mixed-script NFD whose shaping changes only after a physical PDF line wrap", async () => {
    const document = reportFixture();
    const text = "A".repeat(40) + " " + "한글".normalize("NFD").repeat(3);
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }]; document.sections = [];
    for (const Renderer of [ExcelEnergyReportRenderer, PdfEnergyReportRenderer]) {
      await expect(new Renderer().render(document)).rejects.toThrow(/Unsupported report/);
    }
  });
  it("preserves Korean, emoji and representative Unicode through actual glyph extraction in both formats", async () => {
    const document = reportFixture();
    const text = "조명 💡 · café Ω Ж 東京 😀 · e\u0301 ⚡ 👩 🔧";
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }];
    document.sections = [];
    const excel = await new ExcelEnergyReportRenderer().render(document);
    const pdf = await new PdfEnergyReportRenderer().render(document);
    expect(excel.manifest).toEqual(expectedManifest(document));
    expect(pdf.manifest).toEqual(expectedManifest(document));
  });
  it.each([ExcelEnergyReportRenderer, PdfEnergyReportRenderer])("rejects an unsupported scalar consistently (%p)", async Renderer => {
    const document = reportFixture();
    document.metadata = [{ label: "Unicode", value: "\u{10FFFF}", displayValue: "\u{10FFFF}" }];
    document.sections = [];
    await expect(new Renderer().render(document)).rejects.toThrow(/Unsupported report character/);
  });
  it.each(["\u00A0", "\uFE0F", "\u200D"])("rejects non-roundtrippable glyph aliases and join controls in both formats (%j)", async text => {
    const document = reportFixture();
    document.metadata = [{ label: "Unicode", value: text, displayValue: text }]; document.sections = [];
    for (const Renderer of [ExcelEnergyReportRenderer, PdfEnergyReportRenderer]) {
      await expect(new Renderer().render(document)).rejects.toThrow(/Unsupported report character/);
    }
  });
  it.each([ExcelEnergyReportRenderer, PdfEnergyReportRenderer])("preserves CRLF strings without changing the immutable document (%p)", async Renderer => {
    const document = reportFixture();
    document.metadata = [{ label: "줄바꿈", value: "첫째 줄\r\n둘째 줄", displayValue: "첫째 줄\r\n둘째 줄" }];
    document.sections = [];
    const original = structuredClone(document);
    const result = await new Renderer().render(document);
    expect(result.manifest).toEqual(expectedManifest(document));
    expect(document).toEqual(original);
  });
  it("extracts every ordered scalar from both generated files and preserves the input", async () => {
    const document = reportFixture();
    const original = structuredClone(document);
    const [excel, pdf] = await Promise.all([new ExcelEnergyReportRenderer().render(document), new PdfEnergyReportRenderer().render(document)]);
    expect(excel.manifest).toEqual(expectedManifest(document));
    expect(pdf.manifest).toEqual(expectedManifest(document));
    expect(excel.manifest).toEqual(pdf.manifest);
    expect(document).toEqual(original);
  }, 60000);

  it("preserves an empty raw string and a document with no sections", async () => {
    const document = reportFixture();
    document.metadata = [{ label: "빈 원시값", value: "", displayValue: "—" }];
    document.sections = [];
    const [excel, pdf] = await Promise.all([new ExcelEnergyReportRenderer().render(document), new PdfEnergyReportRenderer().render(document)]);
    expect(excel.manifest).toEqual(expectedManifest(document));
    expect(pdf.manifest).toEqual(expectedManifest(document));
  });
});
