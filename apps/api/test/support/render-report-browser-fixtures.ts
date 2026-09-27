import { PdfEnergyReportRenderer, expectedPdfReportManifest } from "../../src/energy/reports/pdf-energy-report.renderer";
import { extractPdfReportManifest } from "../../src/energy/reports/pdf-report-manifest";
import { createHash } from "node:crypto";
import { visualReportFixture } from "../../src/energy/reports/report-renderer.test-support";

// Browser fixtures contain bytes produced and re-read by the real server renderers.
// The browser supplies deterministic job/S3 routes; it does not pretend to run a worker.
async function main() {
  const document = visualReportFixture();
  const pdf = await new PdfEnergyReportRenderer().render(document);
  const displayManifest = expectedPdfReportManifest(document);
  if (JSON.stringify(pdf.manifest) !== JSON.stringify(displayManifest))
    throw new Error("Browser fixture PDF display differs from the immutable document");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  process.stdout.write(JSON.stringify({
    metadata: {
      schemaVersion: document.schemaVersion,
      displayManifest,
      files: {
        pdf: { byteLength: pdf.bytes.byteLength, sha256: digest(pdf.bytes) }
      }
    },
    pdf: {
      bytes: pdf.bytes.toString("base64"),
      manifest: await extractPdfReportManifest(pdf.bytes)
    }
  }));
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
