import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { PdfEnergyReportRenderer, verifyPdfReportManifest } from "../src/energy/reports/pdf-energy-report.renderer";
import { makePdfRichFixture } from "../test/support/pdf-semantic-fixture";

/** Local visual sample only: uses synthetic data and the product renderer,
 * without a database, API server, worker, or object-storage connection.
 * An explicit destination and exclusive creation preserve earlier samples.
 * Run from apps/api: pnpm exec tsx scripts/generate-energy-report-sample.ts /absolute/output.pdf
 */
async function main() {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length || !destination.toLowerCase().endsWith(".pdf"))
    throw new Error("Usage: generate-energy-report-sample.ts <output.pdf>");
  const outputPath = resolve(destination);
  const document = makePdfRichFixture();
  const report = await new PdfEnergyReportRenderer().render(document);
  verifyPdfReportManifest(document, report.manifest);
  const pdf = await PDFDocument.load(report.bytes);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report.bytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ outputPath, pages: pdf.getPageCount(),
    bytes: report.bytes.byteLength, sha256: createHash("sha256").update(report.bytes).digest("hex"),
    dailyRows: report.manifest.filter(entry => /^daily\.\d+\.date$/.test(entry.path)).length }) + "\n");
}

void main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
