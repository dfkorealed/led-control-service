import JSZip from "jszip";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ReportVisualManifest } from "./report-pdf-layout";

/** Resolve actual worksheet drawings to their media bytes, never trust a copied
 * digest in the hidden sheet. Missing/extra drawings and tampered media fail. */
export async function extractExcelReportVisuals(bytes: Uint8Array): Promise<ReportVisualManifest> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const manifestSheet = workbook.getWorksheet("_report_visuals");
  const drawings = workbook.worksheets.flatMap(sheet => sheet.getImages().map(image => ({ sheet, image })));
  if (!manifestSheet) {
    if (drawings.length) throw new Error("Missing report chart manifest");
    return [];
  }
  if (manifestSheet.state !== "veryHidden" || manifestSheet.rowCount !== drawings.length + 1) throw new Error("Invalid report chart manifest");
  const archive = await JSZip.loadAsync(bytes);
  const media = await Promise.all(Object.values(archive.files).filter(entry => /^xl\/media\//.test(entry.name) && !entry.dir).map(entry => entry.async("nodebuffer")));
  if (media.length !== drawings.length) throw new Error("Unexpected report chart media");
  const result: ReportVisualManifest = [];
  for (const [index, { sheet, image }] of drawings.entries()) {
    const row = manifestSheet.getRow(index + 2);
    const png = Buffer.from(workbook.getImage(Number(image.imageId)).buffer as never);
    if (!media.some(bytes => bytes.equals(png))) throw new Error("Missing report chart media");
    const sha256 = createHash("sha256").update(png).digest("hex");
    const metadata = await sharp(png).metadata();
    await sharp(png).raw().toBuffer();
    if (metadata.format !== "png" || row.getCell(2).value !== sha256 || row.getCell(3).value !== metadata.width || row.getCell(4).value !== metadata.height ||
      row.getCell(5).value !== sheet.name || Number(row.getCell(6).value) !== Number(image.imageId)) throw new Error("Invalid report chart media digest or dimensions");
    result.push({ id: String(row.getCell(1).value), sha256, width: metadata.width!, height: metadata.height! });
  }
  if (new Set(result.map(image => image.id)).size !== result.length) throw new Error("Duplicate report chart ID");
  return result;
}

/** XML parsers normalize literal CR/CRLF. Character references preserve the exact
 * scalar string without changing document content or Excel's native numeric cells.
 */
export async function preserveXmlCarriageReturns(bytes: Buffer): Promise<Buffer> {
  const archive = await JSZip.loadAsync(bytes);
  let changed = false;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !entry.name.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    if (!xml.includes("\r")) continue;
    archive.file(entry.name, xml.replace(/\r/g, "&#13;"));
    changed = true;
  }
  return changed ? archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : bytes;
}
