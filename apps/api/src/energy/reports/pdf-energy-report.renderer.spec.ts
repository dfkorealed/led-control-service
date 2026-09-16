import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import { extractPdfReportManifest, extractPdfReportVisuals, extractPdfVisualCaptions } from "./pdf-report-manifest";
import { buildReportVisuals } from "./report-visual-model";
import { expectedManifest, forbiddenReportText, reportFixture, visualReportFixture } from "./report-renderer.test-support";

describe("PdfEnergyReportRenderer", () => {
  it("continues legacy tables even when their original column labels span multiple pages", async () => {
    const document = reportFixture();
    document.metadata = [];
    const table = document.sections[1];
    if (table.kind !== "table") throw new Error("Expected table");
    table.columns[0].label = "매우 긴 한글 열 이름 ".repeat(300);
    document.sections = [table];
    const output = await new PdfEnergyReportRenderer().render(document);
    expect(output.manifest).toEqual(expectedManifest(document));
  }, 60000);
  it("draws eight charts inside page margins and repeats headers on continued tables", async () => {
    const output = await new PdfEnergyReportRenderer().render(visualReportFixture());
    const pdf = await PDFDocument.load(output.bytes);
    let images = 0, repeatedHeaders = 0;
    for (const page of pdf.getPages()) {
      const streams = page.node.Contents() as PDFArray;
      for (let index = 0; index < streams.size(); index++) {
        const text = Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString();
        repeatedHeaders += [...text.matchAll(/\/ReportTableHeader BMC/g)].length;
        for (const match of text.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) cm\s+1 0 0 1 0 0 cm\s+([\d.]+) 0 0 ([\d.]+) 0 0 cm\s+1 0 0 1 0 0 cm\s+\/Image[^\s]* Do/g)) {
          images++;
          const [, x, y, w, h] = match.map(Number);
          expect(w / h).toBeCloseTo(1000 / 560, 5);
          expect(x).toBeGreaterThanOrEqual(36);
          expect(y).toBeGreaterThanOrEqual(44);
          expect(x + w).toBeLessThanOrEqual(559.28);
          expect(y + h).toBeLessThanOrEqual(798);
        }
      }
    }
    expect(images).toBe(8);
    expect(repeatedHeaders).toBeGreaterThan(0);
    expect(await extractPdfVisualCaptions(output.bytes)).toEqual(buildReportVisuals(visualReportFixture()).map(visual => ({ title: visual.title, altText: visual.altText.replace(/–/g, "-") })));
  }, 60000);
  it("detects changed displayed image pixels and removed drawings even when source PNG streams remain intact", async () => {
    const output = await new PdfEnergyReportRenderer().render(visualReportFixture());
    const changed = await PDFDocument.load(output.bytes);
    const first = changed.catalog.lookup(PDFName.of("ReportVisuals"), PDFArray).lookup(0, PDFDict);
    const stream = first.lookup(PDFName.of("Image")) as PDFRawStream;
    const pixels = decodePDFRawStream(stream).decode();
    pixels[0] ^= 255;
    const damaged = changed.context.flateStream(pixels);
    for (const [key, value] of stream.dict.entries()) if (!["/Length", "/Filter"].includes(key.asString())) damaged.dict.set(key, value);
    changed.context.assign(first.get(PDFName.of("Image")) as never, damaged);
    await expect(extractPdfReportVisuals(await changed.save())).rejects.toThrow(/pixels differ/);
    const missing = await PDFDocument.load(output.bytes);
    for (const page of missing.getPages()) {
      const streams = page.node.Contents() as PDFArray;
      for (let index = 0; index < streams.size(); index++) {
        const text = Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString();
        streams.set(index, missing.context.register(missing.context.flateStream(text.replace(/\/ReportVisual0 BMC[\s\S]*?EMC/g, ""))));
      }
    }
    await expect(extractPdfReportVisuals(await missing.save())).rejects.toThrow(/Missing/);
  }, 60000);
  it("rejects serialized page and row permutations while accepting wrapped row continuations", async () => {
    const output = await new PdfEnergyReportRenderer().render(reportFixture());
    const reorderedPages = await PDFDocument.load(output.bytes);
    const page = reorderedPages.getPage(3);
    reorderedPages.removePage(3);
    reorderedPages.insertPage(4, page);
    await expect(extractPdfReportManifest(await reorderedPages.save())).rejects.toThrow(/order/i);

    const reorderedRows = await PDFDocument.load(output.bytes);
    const rowPage = reorderedRows.getPage(3);
    const streams = rowPage.node.Contents() as PDFArray;
    // Move the first physical two-line table row below its successor, preserving token maps.
    const stream = Buffer.from(decodePDFRawStream(streams.lookup(0, PDFRawStream)).decode()).toString();
    const scalarText = [...stream.matchAll(/\/R\d+H[0-3]S\d+ BMC[\s\S]*?EMC/g)].map(match => match[0]).join("\n");
    const positions = [...scalarText.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map(match => Number(match[2]));
    const levels = [...new Set(positions)].sort((a, b) => b - a);
    const swapped = stream.replace(/\/R\d+H[0-3]S\d+ BMC[\s\S]*?EMC/g, segment => segment.replace(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g, (match, x: string, y: string) => {
      const index = levels.indexOf(Number(y));
      return index >= 0 && index < 4 ? `1 0 0 1 ${x} ${levels[(index + 2) % 4]} Tm` : match;
    }));
    streams.set(0, reorderedRows.context.register(reorderedRows.context.flateStream(swapped)));
    await expect(extractPdfReportManifest(await reorderedRows.save())).rejects.toThrow(/order/i);

    const oversized = reportFixture();
    oversized.metadata[0].value = "긴 한글 행 ".repeat(350);
    oversized.metadata[0].displayValue = "원문 표시값";
    expect((await new PdfEnergyReportRenderer().render(oversized)).manifest).toEqual(expectedManifest(oversized));
  }, 60000);
  it("embeds Korean fonts, paginates long content, and writes every label/value into page text", async () => {
    const document = reportFixture();
    const output = await new PdfEnergyReportRenderer().render(document);
    expect(output.contentType).toBe("application/pdf");
    expect(output.extension).toBe("pdf");
    const pdf = await PDFDocument.load(output.bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    let textOperations = 0;
    const checkedFonts = new Set<string>();
    const tokenPages = new Map<number, Set<number>>();
    for (const [pageIndex, page] of pdf.getPages().entries()) {
      expect(page.getSize()).toEqual({ width: 595.28, height: 841.89 });
      const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
      for (const [fontName, ref] of fonts.entries()) {
        if (checkedFonts.has(ref.toString())) continue;
        checkedFonts.add(ref.toString());
        const font = pdf.context.lookup(ref, PDFDict);
        expect(font.has(PDFName.of("ToUnicode"))).toBe(true);
        const descendant = font.lookup(PDFName.of("DescendantFonts"), PDFArray).lookup(0, PDFDict);
        const descriptor = descendant.lookup(PDFName.of("FontDescriptor"), PDFDict);
        expect(descriptor.has(PDFName.of("FontFile2"))).toBe(true);
        const embeddedFont = fontkit.create(decodePDFRawStream(descriptor.lookup(PDFName.of("FontFile2")) as PDFRawStream).decode());
        const cmap = Buffer.from(decodePDFRawStream(font.lookup(PDFName.of("ToUnicode")) as PDFRawStream).decode()).toString();
        const pageStreams = page.node.Contents() as PDFArray;
        const usedGlyphs = new Set<string>();
        for (let index = 0; index < pageStreams.size(); index++) {
          const content = Buffer.from(decodePDFRawStream(pageStreams.lookup(index, PDFRawStream)).decode()).toString();
          const runs = content.matchAll(new RegExp(`${fontName.asString()} [\\d.]+ Tf[\\s\\S]*?<([0-9A-F]*)> Tj`, "gi"));
          for (const run of runs) for (const glyph of run[1].match(/.{4}/g) ?? []) usedGlyphs.add(glyph.toUpperCase());
        }
        for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
          for (const pair of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
            if (!usedGlyphs.has(pair[1].toUpperCase())) continue;
            if (Number.parseInt(pair[2], 16) === 32) continue;
            // ToUnicode alone can look correct while a broken subset has no drawable outline.
            const glyph = embeddedFont.getGlyph(Number.parseInt(pair[1], 16));
            expect(() => glyph.path.toSVG()).not.toThrow();
            expect(glyph.path.toSVG().length).toBeGreaterThan(0);
          }
        }
      }
      const streams = page.node.Contents() as PDFArray;
      for (let index = 0; index < streams.size(); index++) {
        const text = Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString();
        for (const marker of text.matchAll(/\/R(\d+)H[0-3]S\d+ BMC/g)) {
          const id = Number(marker[1]);
          tokenPages.set(id, new Set([...(tokenPages.get(id) ?? []), pageIndex]));
        }
        textOperations += [...text.matchAll(/<([0-9A-F]+)> Tj/gi)].length;
        for (const match of text.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) {
          expect(Number(match[1])).toBeGreaterThanOrEqual(36);
          expect(Number(match[1])).toBeLessThan(559.28);
          expect(Number(match[2])).toBeGreaterThanOrEqual(36);
          expect(Number(match[2])).toBeLessThan(805.89);
        }
      }
    }
    expect(textOperations).toBeGreaterThan(expectedManifest(document).length);
    expect(output.manifest).toEqual(expectedManifest(document));
    // Rows that fit on one page, particularly heatmap coordinates/raw/display, stay together.
    for (const prefix of ["sections.1.rows.7.", ...Array.from({ length: 168 }, (_, index) => `sections.3.cells.${index}.`)]) {
      const pages = output.manifest.flatMap((token, index) => token.path.startsWith(prefix) ? [...tokenPages.get(index)!] : []);
      expect(new Set(pages).size).toBe(1);
    }
    expect(JSON.stringify(output.manifest)).not.toMatch(forbiddenReportText);
    // Remove the title and numeric summary text from the file, keeping the token map intact.
    const removed = ["title", "sections.0.rows.0.value"];
    const tokenIds = removed.map(path => expectedManifest(document).findIndex(token => token.path === path));
    for (const page of pdf.getPages()) {
      const streams = page.node.Contents() as PDFArray;
      for (let index = 0; index < streams.size(); index++) {
        let text = Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString();
        for (const tokenId of tokenIds) text = text.replace(new RegExp(`/R${tokenId}H[0-3]S\\d+ BMC[\\s\\S]*?EMC`, "g"), "");
        streams.set(index, pdf.context.register(pdf.context.flateStream(text)));
      }
    }
    const changed = await extractPdfReportManifest(await pdf.save());
    expect(changed.filter(token => removed.includes(token.path))).toEqual([]);
    expect(changed).toHaveLength(output.manifest.length - removed.length);
  }, 60000);
});
