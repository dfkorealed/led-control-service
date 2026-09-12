import { BadRequestException, Injectable } from "@nestjs/common";
import { energyReportRequestSchema, type EnergyReportDocument } from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { SiteAccessService } from "../../access/site-access.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";

@Injectable()
export class EnergyCsvExportService {
  constructor(private readonly access: SiteAccessService, private readonly snapshots: EnergyReportSnapshotService) {}
  async export(user: AuthenticatedUser, siteId: string, query: unknown): Promise<Readable> {
    await this.access.assert(user, siteId, "read");
    if (!query || typeof query !== "object" || Array.isArray(query) || "format" in query) {
      throw new BadRequestException("invalid CSV request");
    }
    // CSV shares the document's scope/date validation; format is internal only.
    const parsed = energyReportRequestSchema.safeParse({ ...query, format: "xlsx" });
    if (!parsed.success) throw new BadRequestException("invalid CSV request");
    const snapshot = await this.snapshots.capture(randomUUID(), siteId, parsed.data);
    return this.stream(snapshot.documentSnapshot);
  }

  stream(document: EnergyReportDocument): Readable {
    // Rows are encoded only under stream backpressure; no complete CSV string is built.
    return Readable.from(csvRows(document), { objectMode: false, highWaterMark: 16 * 1024 });
  }
}

function* csvRows(document: EnergyReportDocument): Generator<string> {
  yield "\uFEFF";
  yield row([document.title]);
  for (const metadata of document.metadata) yield row([metadata.label, metadata.value, metadata.displayValue]);
  for (const section of document.sections) {
    yield row([section.title]);
    if (section.kind === "table") {
      yield row(section.columns.flatMap(column => [column.label, `${column.label} (표시)`]));
      for (const cells of section.rows) yield row(cells.flatMap(cell => [cell.value, cell.displayValue]));
    } else if (section.kind === "summary") {
      for (const item of section.rows) yield row([item.label, item.value, item.displayValue]);
    } else if (section.kind === "heatmap") {
      yield row(["요일", "시간", "값", "표시"]);
      for (const cell of section.cells) yield row([cell.weekday, cell.hour, cell.value, cell.displayValue]);
    } else {
      for (const note of section.rows) yield row([note]);
    }
  }
  yield row(["문서 식별자", document.reportId]);
  yield row(["문서 지문", document.contentFingerprint]);
}

function row(values: Array<string | number | boolean | null>): string {
  return values.map(value => {
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    let text = value ?? "";
    // Leading whitespace/control characters can hide a spreadsheet formula prefix.
    if (/^[\t\r\n]|^\s*[=+@-]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",") + "\r\n";
}
