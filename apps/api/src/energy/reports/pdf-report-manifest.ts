import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import type { ReportManifest } from "./report-renderer";
import { physicalPdfManifest, type PdfTextRun, type PdfTokenMapping } from "./pdf-report-order";

/** Decode our marked page text through each embedded font's ToUnicode map.
 * Structural metadata supplies paths and scalar types only, never report values.
 */
export async function extractPdfReportManifest(bytes: Uint8Array): Promise<ReportManifest> {
  const pdf = await PDFDocument.load(bytes);
  const mapping = JSON.parse(pdf.catalog.lookup(PDFName.of("ReportTokenMap"), PDFHexString).decodeText()) as PdfTokenMapping[];
  const pages: PdfTextRun[][] = [];
  const cachedFontMaps = new Map<string, Map<string, string>>();
  for (const page of pdf.getPages()) {
    const pageRuns: PdfTextRun[] = [];
    pages.push(pageRuns);
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    const fontMaps = new Map<string, Map<string, string>>();
    for (const [name, reference] of fonts.entries()) {
      const cached = cachedFontMaps.get(reference.toString());
      if (cached) { fontMaps.set(name.asString().slice(1), cached); continue; }
      const font = pdf.context.lookup(reference, PDFDict);
      const unicodeStream = font.lookup(PDFName.of("ToUnicode"));
      if (!(unicodeStream instanceof PDFRawStream)) throw new Error("Missing embedded font character map");
      const cmap = decodeStream(unicodeStream);
      const characters = new Map<string, string>();
      for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
          characters.set(pair[1].toUpperCase().padStart(4, "0"), Buffer.from(pair[2], "hex").swap16().toString("utf16le"));
        }
      }
      fontMaps.set(name.asString().slice(1), characters);
      cachedFontMaps.set(reference.toString(), characters);
    }
    const streams = page.node.Contents() as PDFArray;
    for (let index = 0; index < streams.size(); index++) {
      const content = decodeStream(streams.lookup(index, PDFRawStream));
      for (const segment of content.matchAll(/\/R(\d+)H([0-3])S(\d+) BMC([\s\S]*?)EMC/g)) {
        const tokenIndex = Number(segment[1]);
        if (!mapping[tokenIndex]) throw new Error("Unexpected report text token");
        const runs = [...segment[4].matchAll(/\/([^\s/]+) [\d.]+ Tf[\s\S]*?<([0-9a-f]*)> Tj/gi)];
        if (!runs.length) throw new Error("Missing report text operation");
        let value = ["", "\n", "\r", "\r\n"][Number(segment[2])];
        for (const run of runs) {
          const fontName = run[1];
          const characters = fontMaps.get(fontName);
          if (!characters) throw new Error("Missing report font map");
          for (const glyph of run[2].match(/.{4}/g) ?? []) {
            const character = characters.get(glyph.toUpperCase());
            if (character === undefined) throw new Error(`Unmapped report glyph ${glyph} in ${fontName}`);
            value += character;
          }
        }
        const position = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(segment[4]);
        if (!position) throw new Error("Missing physical report text position");
        pageRuns.push({ index: tokenIndex, part: Number(segment[3]), value, x: Number(position[1]), y: Number(position[2]) });
      }
    }
  }
  return physicalPdfManifest(mapping, pages);
}

function decodeStream(stream: PDFRawStream): string { return Buffer.from(decodePDFRawStream(stream).decode()).toString(); }
