import { ExcelEnergyReportRenderer, extractExcelReportManifest } from "../../src/energy/reports/excel-energy-report.renderer";
import { PdfEnergyReportRenderer } from "../../src/energy/reports/pdf-energy-report.renderer";
import { extractPdfReportManifest } from "../../src/energy/reports/pdf-report-manifest";
import { createHash } from "node:crypto";
import { expectedVisualIds, visualReportFixture } from "../../src/energy/reports/report-renderer.test-support";
import { reportBlocks } from "../../src/energy/reports/report-renderer";

// Browser fixtures contain bytes produced and re-read by the real server renderers.
// The browser supplies deterministic job/S3 routes; it does not pretend to run a worker.
async function main() {
  const document = visualReportFixture();
  const xlsx = await new ExcelEnergyReportRenderer().render(document);
  const pdf = await new PdfEnergyReportRenderer().render(document);
  // V2 calculation inputs and visualization references are fingerprinted but
  // intentionally excluded from the human-readable scalar file manifest.
  const scalarManifest = reportBlocks(document).flatMap((block) => block.groups.flat());
  if (JSON.stringify(xlsx.manifest) !== JSON.stringify(scalarManifest)
    || JSON.stringify(pdf.manifest) !== JSON.stringify(scalarManifest)) {
    throw new Error("Browser fixture scalar manifest differs from the v2 document");
  }
  if (JSON.stringify(xlsx.visuals) !== JSON.stringify(pdf.visuals)
    || JSON.stringify(pdf.visuals.map(({ id }) => id)) !== JSON.stringify(expectedVisualIds)) {
    throw new Error("Browser fixture visual manifests differ or are out of order");
  }
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  process.stdout.write(JSON.stringify({
    metadata: {
      schemaVersion: document.schemaVersion,
      scalarManifest,
      visualIds: pdf.visuals.map(({ id }) => id),
      visualHashes: Object.fromEntries(pdf.visuals.map(({ id, sha256 }) => [id, sha256])),
      files: {
        xlsx: { byteLength: xlsx.bytes.byteLength, sha256: digest(xlsx.bytes) },
        pdf: { byteLength: pdf.bytes.byteLength, sha256: digest(pdf.bytes) }
      }
    },
    xlsx: {
      bytes: xlsx.bytes.toString("base64"),
      manifest: await extractExcelReportManifest(xlsx.bytes),
      visuals: xlsx.visuals
    },
    pdf: {
      bytes: pdf.bytes.toString("base64"),
      manifest: await extractPdfReportManifest(pdf.bytes),
      visuals: pdf.visuals
    }
  }));
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
