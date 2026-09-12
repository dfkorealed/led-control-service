import type { EnergyReportDocument } from "@led-control/shared";
import { Injectable } from "@nestjs/common";
import ExcelJS from "exceljs";
import { preserveXmlCarriageReturns } from "./excel-report-xml";
import { reportBlocks, readTokenValue, tokenType, verifyManifest,
  type EnergyReportRenderer, type RenderedEnergyReport, type ReportManifest } from "./report-renderer";

@Injectable()
export class ExcelEnergyReportRenderer implements EnergyReportRenderer {
  async render(document: EnergyReportDocument): Promise<RenderedEnergyReport> {
    const blocks = reportBlocks(document);
    const workbook = new ExcelJS.Workbook();
    // ExcelJS otherwise injects an English fallback author into the archive metadata.
    workbook.creator = document.title;
    workbook.lastModifiedBy = document.title;
    let section: number | undefined;
    let sheet: ExcelJS.Worksheet;
    for (const block of blocks) {
      if (section !== block.section) {
        section = block.section;
        // Sheet names are layout identifiers; exact untruncated titles remain in cells.
        sheet = workbook.addWorksheet(String(section + 2), { pageSetup: { paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }, views: [{ state: "frozen", ySplit: 2 }] });
      }
      const row = sheet!.addRow([]);
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
    const bytes = await preserveXmlCarriageReturns(Buffer.from(await workbook.xlsx.writeBuffer()));
    const manifest = await extractExcelReportManifest(bytes);
    verifyManifest(blocks, manifest);
    return { bytes, manifest, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
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
