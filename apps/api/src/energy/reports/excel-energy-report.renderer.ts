import type { EnergyReportDocument } from "@led-control/shared";
import { Injectable } from "@nestjs/common";
import ExcelJS from "exceljs";
import { extractExcelReportVisuals, preserveXmlCarriageReturns } from "./excel-report-xml";
import { prepareReportVisuals, visualManifest, verifyVisualManifest, type ReportVisualManifest } from "./report-pdf-layout";
import type { RenderedReportVisual } from "./report-chart-image.renderer";
import { reportBlocks, readTokenValue, tokenType, verifyManifest,
  type EnergyReportRenderer, type RenderedEnergyReport, type ReportManifest } from "./report-renderer";

@Injectable()
export class ExcelEnergyReportRenderer implements EnergyReportRenderer {
  async render(document: EnergyReportDocument, sources?: RenderedReportVisual[]): Promise<RenderedEnergyReport & { visuals: ReportVisualManifest }> {
    const blocks = reportBlocks(document);
    const images = await prepareReportVisuals(document, sources);
    const workbook = new ExcelJS.Workbook();
    // ExcelJS otherwise injects an English fallback author into the archive metadata.
    workbook.creator = document.title;
    workbook.lastModifiedBy = document.title;
    let section: number | undefined;
    let sheet: ExcelJS.Worksheet;
    const placements: Array<[string, string, number, number, string, number]> = [];
    for (const block of blocks) {
      if (section !== block.section) {
        section = block.section;
        // Sheet names are layout identifiers; exact untruncated titles remain in cells.
        sheet = workbook.addWorksheet(String(section + 2), { pageSetup: { paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }, views: [{ state: "frozen", ySplit: 2 }] });
      }
      // Keep the section title first, then charts, then the original table. Every
      // reserved row has a fixed height so Excel cannot collapse image space.
      if (block.style === "columns" || block.style === "heatmap") {
        for (const visual of images.filter(image => image.section === block.section && !placements.some(row => row[0] === image.id))) {
          const title = sheet!.addRow([visual.title]);
          title.height = 24;
          title.getCell(1).font = { name: "Noto Sans KR", size: 12, bold: true };
          const caption = sheet!.addRow([visual.altText]);
          sheet!.mergeCells(caption.number, 1, caption.number, Math.max(4, block.groups.length));
          caption.height = Math.max(45, Math.ceil(visual.altText.length / 65) * 15);
          caption.getCell(1).alignment = { wrapText: true, vertical: "top" };
          caption.getCell(1).font = { name: "Noto Sans KR", size: 10 };
          const top = sheet!.rowCount;
          const width = 700, height = width * visual.height / visual.width;
          for (let index = 0; index < Math.ceil(height / 20) + 1; index++) sheet!.addRow([""]).height = 15;
          const imageId = workbook.addImage({ buffer: visual.png as never, extension: "png" });
          sheet!.addImage(imageId, { tl: { col: 0, row: top }, ext: { width, height }, editAs: "oneCell" });
          placements.push([visual.id, visual.sha256, visual.width, visual.height, sheet!.name, imageId]);
        }
      }
      const row = sheet!.addRow([]);
      if (block.style === "columns") {
        sheet!.pageSetup.printTitlesRow = `${row.number}:${row.number}`;
        // Freezing through chart space can consume the entire viewport (two
        // comparison images). Only the small section heading stays frozen.
      }
      let column = 1;
      for (const group of block.groups) {
        for (const token of group) {
          const cell = row.getCell(column++);
          cell.value = token.value === null ? "null" : token.value;
          // Mapping contains paths/types only; extraction reads the actual serialized cell.
          cell.note = JSON.stringify({ path: token.path, type: tokenType(token.value) });
          cell.font = { name: "Noto Sans KR", size: block.style === "title" ? 17 : 10, bold: block.style === "title" || block.style === "columns", color: { argb: "FF172F42" } };
          cell.alignment = { vertical: "top", wrapText: true };
          if (block.style === "columns" || block.style === "heatmap") cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: token.value === null ? "FFF0F2F4" : "FFE3EEF4" } };
          sheet!.getColumn(cell.col).width = block.style === "heatmap" ? 14 : 28;
        }
      }
      // Excel does not auto-fit wrapped row heights when opened; reserve space explicitly.
      const maxLines = Math.max(...block.groups.flat().map(token => String(token.value ?? "null").split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(Array.from(line).length / 14)), 0)));
      row.height = Math.min(409, Math.max(block.style === "title" ? 32 : 22, maxLines * 15));
    }
    if (placements.length) {
      const manifestSheet = workbook.addWorksheet("_report_visuals", { state: "veryHidden" });
      manifestSheet.addRow(["id", "sha256", "width", "height", "sheet", "imageId"]);
      placements.forEach(placement => manifestSheet.addRow(placement));
    }
    const bytes = await preserveXmlCarriageReturns(Buffer.from(await workbook.xlsx.writeBuffer()));
    const manifest = await extractExcelReportManifest(bytes);
    verifyManifest(blocks, manifest);
    const visuals = await extractExcelReportVisuals(bytes);
    verifyVisualManifest(visualManifest(images), visuals);
    return { bytes, manifest, visuals, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
  }
}

export async function extractExcelReportManifest(bytes: Uint8Array): Promise<ReportManifest> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const manifest: ReportManifest = [];
  workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
    const note = typeof cell.note === "string" ? cell.note : cell.note?.texts?.map(text => text.text).join("");
    if (!note) return;
    const { path, type } = JSON.parse(note) as { path: string; type: string };
    const value = cell.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("Invalid report cell");
    manifest.push({ path, value: readTokenValue(value, type) });
  })));
  return manifest;
}
