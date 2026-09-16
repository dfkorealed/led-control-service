import { energyReportDocumentSchema, type EnergyReportDocument } from "@led-control/shared";
import { assertReportTextSupported } from "./report-text";
import { reportPdfLayout, wrapReportText } from "./report-pdf-layout";

export type ReportValue = string | number | boolean | null;
export type ReportManifest = Array<{ path: string; value: ReportValue }>;
export type RenderedEnergyReport = {
  bytes: Buffer;
  contentType: string;
  extension: "xlsx" | "pdf";
  /** Extracted from the serialized file, never copied from the input document. */
  manifest: ReportManifest;
};
export interface EnergyReportRenderer {
  render(document: EnergyReportDocument): Promise<RenderedEnergyReport>;
}
export type ReportToken = ReportManifest[number];
export type ReportBlock = {
  section: number;
  style: "detail" | "title" | "row" | "columns" | "heatmap";
  groups: ReportToken[][];
};

/** The display traversal preserves v1 order. V2 calculationBasis, source tags,
 * rowIds and visualization instructions are fingerprinted, not display scalars. */
export function reportBlocks(input: EnergyReportDocument): ReportBlock[] {
  const document = energyReportDocumentSchema.parse(input);
  const blocks: ReportBlock[] = [];
  const token = (path: string, value: ReportValue): ReportToken => ({ path, value });
  const fields = (path: string, value: Record<string, ReportValue>) => Object.entries(value).map(([key, value]) => token(`${path}.${key}`, value));
  const add = (section: number, style: ReportBlock["style"], groups: ReportToken[][]) => blocks.push({ section, style, groups });
  add(-1, "detail", [[token("schemaVersion", document.schemaVersion), token("reportId", document.reportId)]]);
  add(-1, "title", [[token("title", document.title)]]);
  document.metadata.forEach((row, index) => add(-1, "row", fields(`metadata.${index}`, row).map(value => [value])));
  document.sections.forEach((section, index) => {
    const path = `sections.${index}`;
    add(index, "detail", [[token(`${path}.kind`, section.kind), ...("id" in section ? [token(`${path}.id`, section.id)] : [])]]);
    add(index, "title", [[token(`${path}.title`, section.title)]]);
    if (section.kind === "summary") {
      section.rows.forEach(({ label, value, displayValue }, rowIndex) => add(index, "row",
        fields(`${path}.rows.${rowIndex}`, { label, value, displayValue }).map(value => [value])));
    } else if (section.kind === "table") {
      add(index, "columns", section.columns.map((column, columnIndex) => fields(`${path}.columns.${columnIndex}`, column)));
      section.rows.forEach((row, rowIndex) => add(index, "row", row.map((cell, columnIndex) => fields(`${path}.rows.${rowIndex}.${columnIndex}`, cell))));
    } else if (section.kind === "heatmap") {
      add(index, "detail", [[token(`${path}.metric`, section.metric)]]);
      // Six consecutive hour cells per row preserve weekday/hour order on A4 pages.
      for (let offset = 0; offset < section.cells.length; offset += 6) {
        add(index, "heatmap", section.cells.slice(offset, offset + 6).map((cell, cellIndex) => fields(`${path}.cells.${offset + cellIndex}`, cell)));
      }
    } else {
      section.rows.forEach((value, rowIndex) => add(index, "row", [[token(`${path}.rows.${rowIndex}`, value)]]));
    }
  });
  add(document.sections.length - 1, "detail", [[token("contentFingerprint", document.contentFingerprint)]]);
  for (const block of blocks) {
    const { isBold, size, groupWidth } = reportPdfLayout(block);
    for (const group of block.groups) for (const token of group) {
      for (const line of wrapReportText(tokenText(token.value), isBold, size, groupWidth - 12)) assertReportTextSupported(line.text);
    }
  }
  return blocks;
}

export function tokenType(value: ReportValue): string { return value === null ? "null" : typeof value; }
export function tokenText(value: ReportValue): string { return value === null ? "null" : String(value); }
export function readTokenValue(text: string | number | boolean, type: string): ReportValue {
  if (type === "null" && text === "null") return null;
  if (type === "string" && typeof text === "string") return text;
  if (type === "number" && String(text).length && Number.isFinite(Number(text))) return Number(text);
  if (type === "boolean" && (String(text) === "true" || String(text) === "false")) return String(text) === "true";
  throw new Error("Invalid report token in generated file");
}
export function verifyManifest(blocks: ReportBlock[], manifest: ReportManifest): void {
  const expected = blocks.flatMap(block => block.groups.flat());
  if (JSON.stringify(expected) !== JSON.stringify(manifest)) throw new Error("Generated report content does not match the immutable document");
}
