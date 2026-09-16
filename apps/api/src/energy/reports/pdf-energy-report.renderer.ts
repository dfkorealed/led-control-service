import type { EnergyReportDocument } from "@led-control/shared";
import { Injectable } from "@nestjs/common";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFArray, PDFDocument, PDFHexString, PDFName, beginMarkedContent, endMarkedContent, rgb, type PDFFont } from "pdf-lib";
import { reportBlocks, tokenText, tokenType, verifyManifest,
  type EnergyReportRenderer, type RenderedEnergyReport, type ReportBlock } from "./report-renderer";
import { extractPdfReportManifest, extractPdfReportVisuals, extractPdfVisualCaptions } from "./pdf-report-manifest";
import { reportFontRuns } from "./report-text";
import { REPORT_PDF_PAGE as PAGE, reportPdfLayout, wrapReportText, prepareReportVisuals, visualManifest, verifyVisualManifest, reportPdfChartSize, reportPdfCaption, type ReportVisualManifest } from "./report-pdf-layout";
import type { RenderedReportVisual } from "./report-chart-image.renderer";

@Injectable()
export class PdfEnergyReportRenderer implements EnergyReportRenderer {
  async render(document: EnergyReportDocument, sources?: RenderedReportVisual[]): Promise<RenderedEnergyReport & { visuals: ReportVisualManifest }> {
    const blocks = reportBlocks(document);
    const images = await prepareReportVisuals(document, sources);
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
    let tableHeader: ReportBlock | undefined;
    const visualMap = pdf.context.obj([]) as PDFArray;
    if (images.length) pdf.catalog.set(PDFName.of("ReportVisuals"), visualMap);
    const drawText = (text: string, x: number, y: number, size: number, isBold: boolean) => {
      for (const run of fontRuns(text, [isBold ? bold : regular, emoji])) {
        page.drawText(run.text, { x, y, size, font: run.font, color: rgb(0.09, 0.18, 0.26) });
        x += run.font.widthOfTextAtSize(run.text, size);
      }
    };
    const newPage = (repeatHeader = false) => {
      page = pdf.addPage([PAGE.width, PAGE.height]); y = PAGE.top;
      if (repeatHeader && tableHeader) {
        const { groupWidth } = reportPdfLayout(tableHeader);
        const lines = tableHeader.groups.map(group => {
          const wrapped = group.flatMap(token => wrapReportText(tokenText(token.value), true, 9, groupWidth - 12));
          // Legacy labels have no length cap and may span whole pages. Keep
          // their original scalar text intact; only decorative repetitions are
          // shortened so every continuation still has room for actual rows.
          return wrapped.length > 12 ? [...wrapped.slice(0, 11), { text: "...", lineBreak: 0 }] : wrapped;
        });
        const height = Math.max(...lines.map(group => group.length)) * 14 + 9;
        // Repeated labels are real text, but deliberately outside scalar token
        // markers: the immutable source contains each header exactly once.
        page.pushOperators(beginMarkedContent("ReportTableHeader"));
        lines.forEach((group, index) => group.forEach((line, offset) => drawText(line.text, PAGE.margin + index * groupWidth + 4, y - offset * 14, 9, true)));
        page.pushOperators(endMarkedContent());
        y -= height;
      }
    };
    for (const block of blocks) {
      if (block.section !== previousSection) {
        newPage();
        tableHeader = undefined;
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
        newPage(block.style === "row");
      }
      // Split oversized rows across pages as synchronized column slices. No text is clipped,
      // while repeated table headers stay outside the immutable scalar manifest.
      for (let offset = 0; offset < lineCount;) {
        if (y - lineHeight < PAGE.bottom) newPage(block.style === "row");
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
      if (block.style === "columns") tableHeader = block;
      if (block.style === "title") {
        for (const visual of images.filter(image => image.section === block.section)) {
          const index = images.indexOf(visual);
          const size = reportPdfChartSize(visual.width, visual.height);
          const title = wrapReportText(reportPdfCaption(visual.title), true, 11, PAGE.width - PAGE.margin * 2 - 8);
          const caption = wrapReportText(reportPdfCaption(visual.altText), false, 9, PAGE.width - PAGE.margin * 2 - 8);
          const height = size.height + (title.length + caption.length) * 14 + 24;
          if (height > PAGE.top - PAGE.bottom) throw new Error("Report chart caption exceeds page capacity");
          if (y - height < PAGE.bottom) newPage();
          for (const [kind, lines] of [["Title", title], ["Alt", caption]] as const) {
            lines.forEach(line => {
              page.pushOperators(beginMarkedContent(`V${index}${kind}H${line.lineBreak}`));
              drawText(line.text, PAGE.margin + 4, y, kind === "Title" ? 11 : 9, kind === "Title");
              page.pushOperators(endMarkedContent());
              y -= 14;
            });
          }
          y -= 8;
          const image = await pdf.embedPng(visual.png);
          // PDF images store decoded RGB/alpha, not the original PNG container.
          // Retain an exact source stream and bind it to the displayed XObject;
          // serialized verification checks both source digest and actual pixels.
          const source = pdf.context.register(pdf.context.stream(visual.png, { Type: "EmbeddedFile", Subtype: "image/png" }));
          visualMap.push(pdf.context.obj({ Id: PDFHexString.fromText(visual.id), Source: source, Image: image.ref }));
          page.pushOperators(beginMarkedContent(`ReportVisual${index}`));
          page.drawImage(image, { x: PAGE.margin, y: y - size.height, ...size });
          page.pushOperators(endMarkedContent());
          y -= size.height + 16;
        }
      }
    }
    const bytes = Buffer.from(await pdf.save());
    const manifest = await extractPdfReportManifest(bytes);
    verifyManifest(blocks, manifest);
    const visuals = await extractPdfReportVisuals(bytes);
    verifyVisualManifest(visualManifest(images), visuals);
    const captions = await extractPdfVisualCaptions(bytes);
    if (JSON.stringify(captions) !== JSON.stringify(images.map(image => ({ title: reportPdfCaption(image.title), altText: reportPdfCaption(image.altText) })))) throw new Error("Invalid serialized report chart captions");
    return { bytes, manifest, visuals, contentType: "application/pdf", extension: "pdf" };
  }
}

function fontRuns(text: string, fonts: PDFFont[]) {
  const runs = reportFontRuns(text).map(run => ({ text: run.text, font: fonts[run.index] }));
  return runs.length ? runs : [{ text: "", font: fonts[0] }];
}
