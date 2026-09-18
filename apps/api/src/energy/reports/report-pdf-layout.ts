import type { ReportBlock } from "./report-renderer";
import { reportTextWidth } from "./report-text";
import type { EnergyReportDocument } from "@led-control/shared";
import { createHash } from "node:crypto";
import { buildReportVisuals } from "./report-visual-model";
import { REPORT_CHART_SIZE, renderReportVisual, validateReportVisualPng, type RenderedReportVisual } from "./report-chart-image.renderer";

export type ReportVisualManifest = Array<{ id: string; sha256: string; width: number; height: number }>;

/** Shared source preparation accepts worker-rendered bytes without re-encoding.
 * Standalone renderers retain the same deterministic default for existing callers. */
export async function prepareReportVisuals(document: EnergyReportDocument, supplied?: RenderedReportVisual[]) {
  const descriptors = buildReportVisuals(document);
  const images = supplied ?? await Promise.all(descriptors.map(renderReportVisual));
  if (images.length !== descriptors.length) throw new Error("Missing report chart images");
  return Promise.all(descriptors.map(async (descriptor, index) => {
    const image = images[index];
    await validateReportVisualPng(image.png);
    if (image.id !== descriptor.id || image.sha256 !== createHash("sha256").update(image.png).digest("hex") ||
      image.width !== REPORT_CHART_SIZE.width || image.height !== REPORT_CHART_SIZE.height || image.altText !== descriptor.altText) throw new Error("Invalid report chart source");
    const section = document.schemaVersion === 2 ? document.sections.findIndex(section => {
      if (!("visualization" in section) || !section.visualization) return false;
      const visual = section.visualization;
      return visual.id === image.id || (visual.type === "period_comparison" && visual.valueColumnIds.some(column => `${visual.id}/${column}` === image.id));
    }) : -1;
    if (section < 0) throw new Error("Missing report chart section");
    return { ...image, section, title: descriptor.title };
  }));
}

export function visualManifest(images: Array<{ id: string; sha256: string; width: number; height: number }>): ReportVisualManifest {
  return images.map(({ id, sha256, width, height }) => ({ id, sha256, width, height }));
}

export function verifyVisualManifest(expected: ReportVisualManifest, actual: ReportVisualManifest): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Generated report chart images do not match their sources");
}

export function reportPdfChartSize(width: number, height: number) {
  const scale = Math.min((REPORT_PDF_PAGE.width - REPORT_PDF_PAGE.margin * 2) / width, 330 / height);
  return { width: width * scale, height: height * scale };
}

/** Generated chart axes use en dashes whose glyph aliases cannot round-trip in
 * Noto's ToUnicode map. Captions use an equivalent ASCII range; scalars and PNG
 * bytes remain untouched, and Korean caption text remains real selectable text. */
export function reportPdfCaption(text: string): string { return text.replace(/–/g, "-"); }

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
