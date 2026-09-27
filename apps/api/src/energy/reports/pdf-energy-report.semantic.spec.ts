import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildPdfReportPresentation } from "./pdf-report-presentation";
import { PdfEnergyReportRenderer, expectedPdfReportManifest, verifyPdfReportManifest } from "./pdf-energy-report.renderer";
import { extractPdfReportManifest } from "./pdf-report-manifest";
import { pdfDisplayFacts } from "./report-pdf-layout";
import { Prisma } from "@prisma/client";
import { makePdfRichFixture, makePdfSemanticFixture as makeDocument } from "../../../test/support/pdf-semantic-fixture";

describe("semantic PDF energy report", () => {
  it("uses six A4 pages for a complete 62-day report and extracts displayed daily facts", async () => {
    const document = makeDocument();
    const output = await new PdfEnergyReportRenderer().render(document);
    const pdf = await PDFDocument.load(output.bytes);
    expect(pdf.getPageCount()).toBe(6);
    expect(pdf.getPages().every(page => page.getWidth() === 595.28 && page.getHeight() === 841.89)).toBe(true);
    expect(output.contentType).toBe("application/pdf");
    expect(output.extension).toBe("pdf");
    expect(output.manifest).toEqual(await extractPdfReportManifest(output.bytes));
    expect(output.manifest).toEqual(expect.arrayContaining([
      { path: "summary.current", value: "69.750 kWh" },
      { path: "summary.previous", value: "69.750 kWh" },
      { path: "daily.0.energy", value: "1.125 kWh" },
      { path: "daily.61.date", value: "2026-08-31" }
    ]));
    expect(output.manifest.filter(token => /^daily\.\d+\.date$/.test(token.path))).toHaveLength(62);
    expect(output.manifest.some(token => token.path === "target")).toBe(false);
    expect(output.manifest.find(token => token.path === "heatmap.peak")?.value).toMatch(/^일요일 00:00 /);
    expect(output.manifest.filter(token => token.path === "document.formula")).toHaveLength(1);
    expect(output.manifest.find(token => token.path === "capturedAt")?.value).toBe("2026-09-01 00:00");
    const model = buildPdfReportPresentation(document);
    expect(model.heatmap.reduce((sum, cell) => sum.add(cell.energy.raw ?? 0), new Prisma.Decimal(0)).toString()).toBe(model.summary.current.raw);
    expect(JSON.stringify(output.manifest)).not.toMatch(/30000000-0000|null|baseline|brightness|group|estimated savings|추정 절감|가상 기준선/);
  }, 60000);

  it("keeps missing days empty and refuses a false comparison", async () => {
    const document = makeDocument(10, true);
    const presentation = buildPdfReportPresentation(document);
    expect(presentation.summary.comparisonAvailable).toBe(false);
    const output = await new PdfEnergyReportRenderer().render(document);
    expect(output.manifest).toContainEqual({ path: "daily.7.energy", value: "데이터 없음" });
    expect(output.manifest).toContainEqual({ path: "summary.difference", value: "비교 불가" });
    expect(output.manifest.some(token => token.path === "summary.previous" && token.value !== "비교 불가")).toBe(false);
    expect(output.manifest.some(token => token.path === "quality.note" && String(token.value).includes("기록 없음"))).toBe(true);
    expect(output.manifest).toContainEqual({ path: "heatmap.coverage", value: "부분 기록" });
  }, 60000);

  it("draws 168 square heatmap cells and keeps measured text inside page bounds", async () => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument(31, false, true));
    const pdf = await PDFDocument.load(output.bytes);
    let cells = 0;
    for (const page of pdf.getPages()) {
      const streams = page.node.Contents() as PDFArray;
      for (let i = 0; i < streams.size(); i++) {
        const content = Buffer.from(decodePDFRawStream(streams.lookup(i, PDFRawStream)).decode()).toString();
        for (const match of content.matchAll(/\/HeatCell\d+ BMC[\s\S]*?0 ([\d.]+) l\s+([\d.]+) \1 l[\s\S]*?EMC/g)) {
          cells++;
          expect(Number(match[1])).toBeCloseTo(Number(match[2]), 4);
          expect(Number(match[1])).toBeLessThanOrEqual(16.1);
        }
        for (const [, x, y] of content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) {
          expect(Number(x)).toBeGreaterThanOrEqual(44);
          expect(Number(x)).toBeLessThanOrEqual(551.28);
          expect(Number(y)).toBeGreaterThanOrEqual(44);
          expect(Number(y)).toBeLessThanOrEqual(798);
        }
      }
    }
    expect(cells).toBe(168);
  }, 60000);

  it("rejects removed visible facts and page reordering after serialization", async () => {
    const document = makeDocument(10);
    const output = await new PdfEnergyReportRenderer().render(document);
    const removed = await PDFDocument.load(output.bytes);
    const streams = removed.getPage(0).node.Contents() as PDFArray;
    for (let index = 0; index < streams.size(); index++) {
      const original = Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString();
      streams.set(index, removed.context.register(removed.context.flateStream(original.replace(/\/D0S0 BMC[\s\S]*?EMC/, ""))));
    }
    await expect(extractPdfReportManifest(await removed.save())).rejects.toThrow(/Missing PDF display value/);
    const reordered = await PDFDocument.load(output.bytes);
    const first = reordered.getPage(0);
    reordered.removePage(0);
    reordered.insertPage(reordered.getPageCount(), first);
    await expect(extractPdfReportManifest(await reordered.save())).rejects.toThrow(/display order/);
    expect(() => verifyPdfReportManifest(document, output.manifest.slice(1))).toThrow(/differs/);
    expect(output.manifest).toEqual(expectedPdfReportManifest(document));
  }, 60000);

  it("uses vector charts and does not pre-render the removed eight-image set", async () => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument(10));
    const pdf = await PDFDocument.load(output.bytes);
    expect(pdf.catalog.has(PDFName.of("ReportVisuals"))).toBe(false);
    expect(output.visuals).toEqual([]);
    for (const page of pdf.getPages()) {
      const streams = page.node.Contents() as PDFArray;
      for (let index = 0; index < streams.size(); index++) {
        const content = Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString();
        expect(content).not.toMatch(/\/Image[^\s]* Do/);
      }
    }
  }, 60000);

  it("adds monthly detail pages for a longer period", async () => {
    const document = makeDocument(75);
    const output = await new PdfEnergyReportRenderer().render(document);
    expect((await PDFDocument.load(output.bytes)).getPageCount()).toBe(7);
    expect(output.manifest.filter(token => /^daily\.\d+\.date$/.test(token.path))).toHaveLength(75);
  }, 60000);

  it("summarizes extensive quality notes while preserving the reason", () => {
    const model = buildPdfReportPresentation(makeDocument(10, true));
    model.quality.notes = [...Array.from({ length: 60 }, (_, index) => `이번 기간 2026-07-${String(index + 1).padStart(2, "0")}: 기록 없음`),
      "요일·시간별 전력량: 시간별 일부 기록만 있음"];
    const note = pdfDisplayFacts(model).find(token => token.path === "quality.note")!.value as string;
    expect(note).toContain("기록 없음");
    expect(note).toContain("요일·시간별 전력량");
    expect(note).toContain("59건");
    expect(note.length).toBeLessThan(180);
  });

  it("omits empty attribution cards when the whole current period is missing", async () => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument(10, false, false, true));
    expect((await PDFDocument.load(output.bytes)).getPageCount()).toBe(4);
    expect(output.manifest.some(token => token.path.startsWith("floors.") || token.path.startsWith("fixtures."))).toBe(false);
    expect(output.manifest.filter(token => /^daily\.\d+\.energy$/.test(token.path)).every(token => token.value === "데이터 없음")).toBe(true);
  }, 60000);

  it("sizes floor and fixture cards to their actual rows", async () => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument());
    const pdf = await PDFDocument.load(output.bytes);
    const streams = pdf.getPage(2).node.Contents() as PDFArray;
    const content = Array.from({ length: streams.size() }, (_, index) =>
      Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString()).join("\n");
    const heights = [...content.matchAll(/1 0 0 1 44 [\d.]+ cm[\s\S]*?0 ([\d.]+) l\s+507 \1 l/g)].map(match => Number(match[1]));
    expect(heights.slice(0, 2)).toHaveLength(2);
    expect(heights.slice(0, 2).every(height => height < 180)).toBe(true);
  }, 60000);

  it("renders two floor bars and top five plus other from variable 62-day usage", async () => {
    const document = makePdfRichFixture();
    const model = buildPdfReportPresentation(document);
    expect(model.floors.rows).toHaveLength(2);
    expect(model.fixtures.topFive).toHaveLength(5);
    expect(model.fixtures.other.raw).not.toBe("0");
    expect(new Set(model.daily.map(day => day.energy.raw)).size).toBeGreaterThan(2);
    const output = await new PdfEnergyReportRenderer().render(document);
    expect((await PDFDocument.load(output.bytes)).getPageCount()).toBe(6);
    expect(output.manifest.filter(token => /^fixtures\.\d+\.name$/.test(token.path))).toHaveLength(5);
    expect(output.manifest).toContainEqual({ path: "fixtures.other", value: model.fixtures.other.text });
  }, 120000);

  it("keeps comparison, monthly, heatmap, and formula cards close to their content", async () => {
    const output = await new PdfEnergyReportRenderer().render(makePdfRichFixture());
    const pdf = await PDFDocument.load(output.bytes);
    const cardHeights = (pageIndex: number) => {
      const streams = pdf.getPage(pageIndex).node.Contents() as PDFArray;
      const content = Array.from({ length: streams.size() }, (_, index) =>
        Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString()).join("\n");
      return [...content.matchAll(/1 0 0 1 44 [\d.]+ cm[\s\S]*?0 ([\d.]+) l\s+507 \1 l/g)].map(match => Number(match[1]));
    };
    expect(cardHeights(0).at(-1)).toBeLessThan(145);
    expect(cardHeights(1).at(-1)).toBeLessThan(140);
    expect(cardHeights(3)[0]).toBeLessThan(285);
    expect(cardHeights(3).at(-1)).toBeLessThan(140);
  }, 120000);

  it("fits exact grouped large stored costs into KPI, monthly, and daily rows", async () => {
    const document = makeDocument(31, false, false, false, true);
    const output = await new PdfEnergyReportRenderer().render(document);
    expect(output.manifest.find(token => token.path === "summary.storedCost")?.value).toBe(buildPdfReportPresentation(document).summary.storedCost.text);
    expect(output.manifest.filter(token => /^daily\.\d+\.cost$/.test(token.path))).toHaveLength(31);
  }, 60000);
});
