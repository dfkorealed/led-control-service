import { ExcelEnergyReportRenderer, extractExcelReportManifest } from "../../src/energy/reports/excel-energy-report.renderer";
import { PdfEnergyReportRenderer } from "../../src/energy/reports/pdf-energy-report.renderer";
import { extractPdfReportManifest } from "../../src/energy/reports/pdf-report-manifest";
import { expectedManifest } from "../../src/energy/reports/report-renderer.test-support";
import { EnergyReportDocumentBuilder } from "../../src/energy/reports/energy-report-document.builder";

// Browser fixtures contain bytes produced and re-read by the real server renderers.
// The browser supplies deterministic job/S3 routes; it does not pretend to run a worker.
async function main() {
  const siteId = "30000000-0000-4000-8000-000000000001";
  const document = new EnergyReportDocumentBuilder().build("30000000-0000-4000-8000-000000000040",
    { from: "2026-09-01", to: "2026-09-07", scope: "site", identityId: siteId, format: "xlsx" }, {
      schemaVersion: 1, capturedAt: "2026-09-12T00:00:00.000Z", site: { id: siteId, name: "조명 💡 현장", timeZone: "Asia/Seoul" },
      comparisonRange: { from: "2026-08-25", to: "2026-08-31" }, fixtures: [{
        id: "30000000-0000-4000-8000-000000000021", from: "2026-01-01T00:00:00.000Z", to: null,
        dimensions: [{ from: "2026-01-01T00:00:00.000Z", to: null, name: "조명 💡", floorId: "30000000-0000-4000-8000-000000000010", floorName: "1층" }],
        groups: [], daily: [{ localDate: "2026-09-01", energyKwh: "1.25", cost: "187.5", durationSeconds: 3600 },
          { localDate: "2026-08-31", energyKwh: "0.5", cost: "50", durationSeconds: 3600 }],
        hourly: [{ bucketStartUtc: "2026-09-01T00:00:00.000Z", localDate: "2026-09-01", localHour: 9,
          energyKwh: "1.25", durationSeconds: 3600, brightnessWeightedSeconds: "180000" }]
      }]
    });
  const xlsx = await new ExcelEnergyReportRenderer().render(document);
  const pdf = await new PdfEnergyReportRenderer().render(document);
  process.stdout.write(JSON.stringify({
    expected: expectedManifest(document),
    xlsx: { bytes: xlsx.bytes.toString("base64"), manifest: await extractExcelReportManifest(xlsx.bytes) },
    pdf: { bytes: pdf.bytes.toString("base64"), manifest: await extractPdfReportManifest(pdf.bytes) }
  }));
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
