import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { EnergyCsvExportService } from "./energy-csv-export.service";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import { EnergyReportDocumentBuilder } from "./energy-report-document.builder";
import { reportFixture } from "./report-renderer.test-support";

const siteId = "20000000-0000-4000-8000-000000000001";
const query = { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: siteId };
function setup() {
  const tx = { site: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: siteId, name: "서울", timeZone: "UTC" }) },
    energyFixtureIdentity: { findMany: jest.fn().mockResolvedValue([]) } };
  const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const access = { assert: jest.fn().mockResolvedValue(undefined) };
  const snapshot = new EnergyReportSnapshotService(prisma as never, new EnergyReportDocumentBuilder());
  return { prisma, access, service: new EnergyCsvExportService(access as never, snapshot) };
}
async function read(stream: Readable) { let text = ""; for await (const chunk of stream) text += chunk.toString(); return text; }

describe("EnergyCsvExportService", () => {
  it("streams BOM, metadata and ordered common table raw/display values with CSV quoting", async () => {
    const { service } = setup();
    const document = reportFixture();
    document.metadata = [{ label: "현장", value: '서울, "A"\r\n동', displayValue: '서울, "A"\r\n동' }];
    const stream = service.stream(document);
    expect(stream).toBeInstanceOf(Readable);
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", chunk => chunks.push(chunk.toString()));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks[0]).toBe("\uFEFF");
    const csv = chunks.join("");
    expect(csv).toContain('"현장","서울, ""A""\r\n동","서울, ""A""\r\n동"\r\n');
    expect(csv).toContain('"이름","이름 (표시)","사용 전력량","사용 전력량 (표시)"\r\n');
    expect(csv).toContain(',0,"0.0000 kWh"\r\n');
    expect(csv).toContain(',"","데이터 없음"\r\n');
    expect(csv).not.toMatch(/coverage|known|forecast|baseline|예상|추정/i);
  });

  it.each(['=SUM(1,2)', '+cmd', '-cmd', '@cmd', '\t=1', '\r=1', '\n=1', '  =1'])("neutralizes spreadsheet formula prefix %j", async value => {
    const { service } = setup();
    const document = reportFixture();
    document.metadata = [{ label: "이름", value, displayValue: value }];
    const csv = await read(service.stream(document));
    expect(csv).toContain(`"'${value.replaceAll('"', '""')}"`);
  });

  it("does not materialize table CSV rows before they are consumed", async () => {
    const { service } = setup();
    const document = reportFixture();
    const table = document.sections.find(section => section.kind === "table")!;
    if (table.kind !== "table") throw new Error("fixture");
    const getter = jest.fn(() => "긴 셀");
    Object.defineProperty(table.rows[0][0], "displayValue", { get: getter });
    const stream = service.stream(document);
    expect(getter).not.toHaveBeenCalled();
    await read(stream);
    expect(getter).toHaveBeenCalled();
  });

  it("authorizes before snapshot reads and rejects unrecognized query fields", async () => {
    const { service, access, prisma } = setup();
    access.assert.mockRejectedValue(new NotFoundException());
    await expect(service.export({ id: "actor" } as never, siteId, query)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    access.assert.mockResolvedValue(undefined);
    await expect(service.export({ id: "actor" } as never, siteId, { ...query, sections: ["summary"] })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const csv = await read(await service.export({ id: "actor" } as never, siteId, query));
    expect(access.assert).toHaveBeenLastCalledWith({ id: "actor" }, siteId, "read");
    expect(csv).toContain("서울");
  });
});
