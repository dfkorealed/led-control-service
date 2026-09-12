import type { EnergyReportDocument } from "@led-control/shared";
import { Injectable } from "@nestjs/common";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFHexString, PDFName, beginMarkedContent, endMarkedContent, rgb, type PDFFont } from "pdf-lib";
import { reportBlocks, tokenText, tokenType, verifyManifest,
  type EnergyReportRenderer, type RenderedEnergyReport } from "./report-renderer";
import { extractPdfReportManifest } from "./pdf-report-manifest";
import { reportFontRuns } from "./report-text";
import { REPORT_PDF_PAGE as PAGE, reportPdfLayout, wrapReportText } from "./report-pdf-layout";

@Injectable()
export class PdfEnergyReportRenderer implements EnergyReportRenderer {
  async render(document: EnergyReportDocument): Promise<RenderedEnergyReport> {
    const blocks = reportBlocks(document);
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const [regular, bold] = await Promise.all(["Regular", "Bold"].map(async weight => {
      const bytes = await readFile(join(__dirname, "../../assets/fonts", `NotoSansKR-${weight}.ttf`));
      // fontkit 1.1.1 corrupts some Noto KR subset outlines even with valid ToUnicode.
      // Intact fonts and un-substituted cmap glyphs preserve drawable, extractable text.
      const features = Object.fromEntries(fontkit.create(bytes).availableFeatures.map(feature => [feature, false]));
      return pdf.embedFont(bytes, { subset: false, features, customName: `NotoSansKR-${weight}` });
    }));
    const emojiBytes = await readFile(join(__dirname, "../../assets/fonts/NotoEmoji.ttf"));
    const emoji = await pdf.embedFont(emojiBytes, { subset: false, customName: "NotoEmoji",
      features: Object.fromEntries(fontkit.create(emojiBytes).availableFeatures.map(feature => [feature, false])) });
    // This map deliberately has no values: manifests must decode the page's actual glyphs.
    const mapping = blocks.flatMap((block, blockIndex) => block.groups.flatMap((group, groupIndex) =>
      group.map(token => ({ path: token.path, type: tokenType(token.value), block: blockIndex, group: groupIndex }))));
    pdf.catalog.set(PDFName.of("ReportTokenMap"), PDFHexString.fromText(JSON.stringify(mapping)));
    let page = pdf.addPage([PAGE.width, PAGE.height]);
    let y = PAGE.top;
    let previousSection = -1;
    let tokenIndex = 0;
    for (const block of blocks) {
      if (block.section !== previousSection) {
        page = pdf.addPage([PAGE.width, PAGE.height]);
        y = PAGE.top;
        previousSection = block.section;
      }
      const { isBold, size, lineHeight, groupWidth } = reportPdfLayout(block);
      const fonts = [isBold ? bold : regular, emoji];
      const lines = block.groups.map(group => group.flatMap(token => {
        const index = tokenIndex++;
        return wrapReportText(tokenText(token.value), isBold, size, groupWidth - 12).map((line, part) => ({ ...line, index, part }));
      }));
      const lineCount = Math.max(...lines.map(group => group.length));
      if (lineCount * lineHeight <= PAGE.top - PAGE.bottom && y - lineCount * lineHeight < PAGE.bottom) {
        page = pdf.addPage([PAGE.width, PAGE.height]); y = PAGE.top;
      }
      // Split oversized rows across pages as synchronized column slices. No text is clipped,
      // and continuation pages never repeat labels or content from the immutable document.
      for (let offset = 0; offset < lineCount;) {
        if (y - lineHeight < PAGE.bottom) { page = pdf.addPage([PAGE.width, PAGE.height]); y = PAGE.top; }
        const count = Math.min(lineCount - offset, Math.floor((y - PAGE.bottom) / lineHeight));
        lines.forEach((group, groupIndex) => {
          const x = PAGE.margin + groupIndex * groupWidth;
          if (block.style === "heatmap" || block.style === "columns") {
            page.drawRectangle({ x, y: y - count * lineHeight + 3, width: groupWidth - 3, height: count * lineHeight + 5,
              color: block.style === "heatmap" ? rgb(0.89, 0.94, 0.97) : rgb(0.94, 0.96, 0.98) });
          }
          group.slice(offset, offset + count).forEach((line, lineIndex) => {
            page.pushOperators(beginMarkedContent(`R${line.index}H${line.lineBreak}S${line.part}`));
            let runX = x + 4;
            for (const run of fontRuns(line.text, fonts)) {
              page.drawText(run.text, { x: runX, y: y - lineIndex * lineHeight, size, font: run.font, color: rgb(0.09, 0.18, 0.26) });
              runX += run.font.widthOfTextAtSize(run.text, size);
            }
            page.pushOperators(endMarkedContent());
          });
        });
        y -= count * lineHeight;
        offset += count;
      }
      y -= block.style === "title" ? 14 : 9;
    }
    const bytes = Buffer.from(await pdf.save());
    const manifest = await extractPdfReportManifest(bytes);
    verifyManifest(blocks, manifest);
    return { bytes, manifest, contentType: "application/pdf", extension: "pdf" };
  }
}

function fontRuns(text: string, fonts: PDFFont[]) {
  const runs = reportFontRuns(text).map(run => ({ text: run.text, font: fonts[run.index] }));
  return runs.length ? runs : [{ text: "", font: fonts[0] }];
}
