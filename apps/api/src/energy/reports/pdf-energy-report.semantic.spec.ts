import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildPdfReportPresentation } from "./pdf-report-presentation";
import { PdfEnergyReportRenderer, expectedPdfReportManifest, verifyPdfReportManifest } from "./pdf-energy-report.renderer";
import { extractPdfReportManifest } from "./pdf-report-manifest";
import { pdfDisplayFacts } from "./report-pdf-layout";
import { Prisma } from "@prisma/client";
import { reportTextWidth } from "./report-text";
import { makePdfManyFloorsFixture, makePdfRichFixture, makePdfSemanticFixture as makeDocument } from "../../../test/support/pdf-semantic-fixture";

function pageContent(pdf: PDFDocument, pageIndex: number): string {
  const streams = pdf.getPage(pageIndex).node.Contents() as PDFArray;
  return Array.from({ length: streams.size() }, (_, index) =>
    Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString()).join("\n");
}

/** Read every visible glyph, including headings outside the fact manifest. */
function pageTextRuns(pdf: PDFDocument, pageIndex: number) {
  const fonts = pdf.getPage(pageIndex).node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
  const maps = new Map<string, Map<string, string>>();
  for (const [name, reference] of fonts.entries()) {
    const font = pdf.context.lookup(reference, PDFDict);
    const cmap = Buffer.from(decodePDFRawStream(font.lookup(PDFName.of("ToUnicode")) as PDFRawStream).decode()).toString();
    const characters = new Map<string, string>();
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const pair of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi))
        characters.set(pair[1].toUpperCase(), Buffer.from(pair[2], "hex").swap16().toString("utf16le"));
    maps.set(name.asString().slice(1), characters);
  }
  return [...pageContent(pdf, pageIndex).matchAll(/\/([^\s/]+) ([\d.]+) Tf[\s\S]*?1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*<([0-9a-f]*)> Tj/gi)]
    .map(([, font, size, x, y, glyphs]) => ({ size: Number(size), x: Number(x), y: Number(y),
      text: (glyphs.match(/.{4}/g) ?? []).map(glyph => {
        const character = maps.get(font)?.get(glyph.toUpperCase());
        if (character === undefined) throw new Error("Unmapped test PDF glyph");
        return character;
      }).join("") }));
}

function pathsOnPage(pdf: PDFDocument, pageIndex: number, manifest: Awaited<ReturnType<PdfEnergyReportRenderer["render"]>>["manifest"]) {
  return [...pageContent(pdf, pageIndex).matchAll(/\/D(\d+)S\d+ BMC/g)].map(match => manifest[Number(match[1])].path);
}

describe("semantic PDF energy report", () => {
  it("puts only centered title and scope metadata on the cover before the summary", async () => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument());
    const pdf = await PDFDocument.load(output.bytes);
    const cover = pageTextRuns(pdf, 0);
    expect(cover.map(run => run.text)).toEqual([
      "조명 에너지 사용 보고서", "현장: 서울 현장", "보고 범위: 현장 전체", "2026-07-01 ~ 2026-08-31"
    ]);
    for (const run of cover)
      expect(run.x + reportTextWidth(run.text, run.text === "조명 에너지 사용 보고서", run.size) / 2).toBeCloseTo(297.64, 3);
    expect(pathsOnPage(pdf, 0, output.manifest)).toEqual(["site", "scope", "period"]);
    expect(pathsOnPage(pdf, 1, output.manifest)).toEqual(["summary.current", "summary.previous", "summary.difference", "summary.storedCost"]);
    expect(pageTextRuns(pdf, 1).map(run => run.text)).toContain("핵심 결과");
    expect(pdf.getPageCount()).toBe(7);
  }, 60000);

  it("omits status UI and capture time while keeping missing-data and comparison reasons", async () => {
    const document = makeDocument(10, true);
    const before = JSON.stringify(document);
    const output = await new PdfEnergyReportRenderer().render(document);
    const pdf = await PDFDocument.load(output.bytes);
    const text = pdf.getPages().flatMap((_, index) => pageTextRuns(pdf, index).map(run => run.text)).join("\n");
    expect(text).not.toMatch(/자료 확인|자료 상태|^자료$|^완전$|^부분 기록$|UTC|2026-09-01 00:00/m);
    expect(output.manifest.some(entry => entry.path === "quality.current" || entry.path === "heatmap.coverage" ||
      entry.path === "timeZone" || entry.path === "capturedAt" || /^daily\.\d+\.status$/.test(entry.path))).toBe(false);
    expect(text).toContain("현재 또는 직전 동일 일수의 수집 기록이 완전하지 않습니다.");
    expect(output.manifest).toContainEqual({ path: "daily.7.energy", value: "데이터 없음" });
    expect(output.manifest).toContainEqual({ path: "summary.previous", value: "비교 불가" });
    expect(output.manifest.some(entry => entry.path.startsWith("floors.") && String(entry.value).includes("부분 기록"))).toBe(true);
    expect(text).toContain("기록 없음");
    expect(JSON.stringify(document)).toBe(before);
    if (document.schemaVersion !== 2) throw new Error("Expected v2 fixture");
    expect(document.calculationBasis.capturedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(document.metadata).toContainEqual(expect.objectContaining({ label: "시간대", value: "UTC" }));
  }, 60000);

  it("uses usage ranking headings on continued pages and the hourly usage heading", async () => {
    const output = await new PdfEnergyReportRenderer().render(makePdfManyFloorsFixture(20));
    const pdf = await PDFDocument.load(output.bytes);
    expect(pageTextRuns(pdf, 3).map(run => run.text)).toContain("사용량 순위");
    expect(pageTextRuns(pdf, 4).map(run => run.text)).toContain("사용량 순위 (계속)");
    const text = pdf.getPages().flatMap((_, index) => pageTextRuns(pdf, index).map(run => run.text));
    expect(text).toContain("시간대별 사용량");
    expect(text).not.toContain("어디에서 사용했나");
    expect(text).not.toContain("언제 사용했나");
  }, 60000);

  it("uses seven A4 pages for a complete 62-day report and extracts displayed daily facts", async () => {
    const document = makeDocument();
    const output = await new PdfEnergyReportRenderer().render(document);
    const pdf = await PDFDocument.load(output.bytes);
    expect(pdf.getPageCount()).toBe(7);
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
    expect(output.manifest.some(token => token.path === "heatmap.coverage")).toBe(false);
  }, 60000);

  it("draws 168 square heatmap cells and keeps measured text inside page bounds", async () => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument(31, false, true, false, false, { scope: "fixture" }));
    const pdf = await PDFDocument.load(output.bytes);
    const cover = pageTextRuns(pdf, 0);
    expect(cover.length).toBeGreaterThan(4);
    for (const run of cover)
      expect(run.x + reportTextWidth(run.text, run.text === "조명 에너지 사용 보고서", run.size) / 2).toBeCloseTo(297.64, 3);
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
    expect((await PDFDocument.load(output.bytes)).getPageCount()).toBe(8);
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
    expect((await PDFDocument.load(output.bytes)).getPageCount()).toBe(5);
    expect(output.manifest.some(token => token.path.startsWith("floors.") || token.path.startsWith("fixtures."))).toBe(false);
    expect(output.manifest.filter(token => /^daily\.\d+\.energy$/.test(token.path)).every(token => token.value === "데이터 없음")).toBe(true);
  }, 60000);

  it("sizes floor and fixture cards to their actual rows", async () => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument());
    const pdf = await PDFDocument.load(output.bytes);
    const streams = pdf.getPage(3).node.Contents() as PDFArray;
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
    expect((await PDFDocument.load(output.bytes)).getPageCount()).toBe(7);
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
    expect(cardHeights(1).at(-1)).toBeLessThan(145);
    expect(cardHeights(2).at(-1)).toBeLessThan(140);
    expect(cardHeights(4)[0]).toBeLessThan(285);
    expect(cardHeights(4).at(-1)).toBeLessThan(140);
  }, 120000);

  it("fits exact grouped large stored costs into KPI, monthly, and daily rows", async () => {
    const document = makeDocument(31, false, false, false, true);
    const output = await new PdfEnergyReportRenderer().render(document);
    expect(output.manifest.find(token => token.path === "summary.storedCost")?.value).toBe(buildPdfReportPresentation(document).summary.storedCost.text);
    expect(output.manifest.filter(token => /^daily\.\d+\.cost$/.test(token.path))).toHaveLength(31);
  }, 60000);

  it.each([17, 20])("paginates %i ordinary floors with a heading on every floor page", async floorCount => {
    const document = makePdfManyFloorsFixture(floorCount);
    const output = await new PdfEnergyReportRenderer().render(document);
    const pdf = await PDFDocument.load(output.bytes);
    const pathsOnPage = (index: number) => [...pageContent(pdf, index).matchAll(/\/D(\d+)S\d+ BMC/g)]
      .map(match => output.manifest[Number(match[1])].path);
    expect(pdf.getPageCount()).toBe(7);
    expect(pathsOnPage(3).filter(path => /^floors\.\d+\.name$/.test(path)).length).toBeGreaterThan(0);
    expect(pathsOnPage(4).filter(path => /^floors\.\d+\.name$/.test(path)).length).toBeGreaterThan(0);
    expect([3, 4].flatMap(pathsOnPage).filter(path => /^floors\.\d+\.name$/.test(path))).toHaveLength(floorCount);
    expect(pageContent(pdf, 3)).toContain("/FloorHeading BMC");
    expect(pageContent(pdf, 4)).toContain("/FloorHeading BMC");
    expect(pathsOnPage(4).some(path => path.startsWith("fixtures."))).toBe(true);
  }, 120000);

  it.each(["site", "floor", "group", "fixture"] as const)("distinguishes the site and %s report target even when names match", async scope => {
    const document = makeDocument(10, false, false, false, false, { scope, sameNameTarget: true });
    const output = await new PdfEnergyReportRenderer().render(document);
    expect(output.manifest).toContainEqual({ path: "site", value: "현장: 서울 현장" });
    expect(output.manifest).toContainEqual({ path: "scope", value: scope === "site"
      ? "보고 범위: 현장 전체" : `보고 범위: ${{ floor: "층", group: "그룹", fixture: "조명" }[scope]} · 서울 현장` });
    expect(output.manifest.filter(entry => entry.path === "scope")).toHaveLength(1);
  }, 60000);

  it.each(["partial", "unknown"] as const)("breaks the daily trend across a %s day that has a recorded amount", async status => {
    const document = makeDocument(10, false, false, false, false, { partialDay: status });
    const model = buildPdfReportPresentation(document);
    expect(model.daily[7]).toMatchObject({ completeness: status, energy: { raw: "1.125" } });
    const output = await new PdfEnergyReportRenderer().render(document);
    const chart = pageContent(await PDFDocument.load(output.bytes), 2);
    expect([...chart.matchAll(/1\.3 w[\s\S]*?[-\d.]+ [-\d.]+ m\s+[-\d.]+ [-\d.]+ l/g)]).toHaveLength(7);
    expect(output.manifest).toContainEqual({ path: "trend.note",
      value: "선은 완전 기록일만 연결하며 나머지 날짜는 제외" });
  }, 60000);

  it.each(["partial", "unknown"] as const)("withholds incomplete %s daily amounts without a status column", async status => {
    const output = await new PdfEnergyReportRenderer().render(makeDocument(10, false, false, false, false, { partialDay: status }));
    expect(output.manifest).toContainEqual({ path: "daily.7.energy", value: "집계 불가" });
    expect(output.manifest).toContainEqual({ path: "daily.7.cost", value: "집계 불가" });
    expect(output.manifest.some(entry => /^daily\.\d+\.status$/.test(entry.path))).toBe(false);
  }, 60000);

  it("shows an isolated complete day and both gap boundaries without dotting every day", async () => {
    const document = makeDocument(62, false, false, false, false,
      { incompleteDays: { 6: "partial", 8: "unknown" } });
    const model = buildPdfReportPresentation(document);
    expect(model.daily.slice(6, 9).map(day => day.completeness)).toEqual(["partial", "complete", "unknown"]);
    const output = await new PdfEnergyReportRenderer().render(document);
    const chart = pageContent(await PDFDocument.load(output.bytes), 2);
    const pointXs = [...chart.matchAll(/0 w\s+\[\] 0 d\s+q\s+([\d.]+) [\d.]+ m\s+[\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ c/g)]
      .map(match => Number(match[1]) + 1.7);
    for (const boundaryX of [126.836, 140.770, 154.705])
      expect(pointXs.some(x => Math.abs(x - boundaryX) < 0.01)).toBe(true);
    for (const incompleteX of [133.803, 147.738])
      expect(pointXs.some(x => Math.abs(x - incompleteX) < 0.01)).toBe(false);
    expect(pointXs.length).toBeLessThan(20);
  }, 60000);
});
