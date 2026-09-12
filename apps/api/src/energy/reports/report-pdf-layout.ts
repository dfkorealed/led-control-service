import type { ReportBlock } from "./report-renderer";
import { reportTextWidth } from "./report-text";

export const REPORT_PDF_PAGE = { width: 595.28, height: 841.89, margin: 36, top: 798, bottom: 44 };

export function reportPdfLayout(block: ReportBlock) {
  return {
    isBold: block.style === "title" || block.style === "columns",
    size: block.style === "title" ? 18 : block.style === "detail" || block.style === "heatmap" ? 8 : 9,
    lineHeight: block.style === "title" ? 26 : 14,
    groupWidth: (REPORT_PDF_PAGE.width - REPORT_PDF_PAGE.margin * 2) / block.groups.length
  };
}

/** Share physical line boundaries with acceptance checks: wrapping can change shaping. */
export function wrapReportText(text: string, isBold: boolean, size: number, width: number) {
  const result: Array<{ text: string; lineBreak: number }> = [];
  const paragraphs = text.split(/(\r\n|\r|\n)/);
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 2) {
    let line = "";
    // A line break has no glyph; the PDF marker retains its exact CR/LF spelling.
    let lineBreak = ["", "\n", "\r", "\r\n"].indexOf(paragraphs[paragraphIndex - 1] ?? "");
    for (const character of paragraphs[paragraphIndex]) {
      if (line && reportTextWidth(line + character, isBold, size) > width) {
        result.push({ text: line, lineBreak }); line = ""; lineBreak = 0;
      }
      line += character;
    }
    result.push({ text: line, lineBreak });
  }
  return result;
}
