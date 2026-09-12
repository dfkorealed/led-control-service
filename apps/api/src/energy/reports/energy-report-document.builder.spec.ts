import { createHash } from "node:crypto";
import { energyReportDocumentSchema, type EnergyReportRequest, type EnergyReportDocument } from "@led-control/shared";
import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot } from "./energy-report-document.builder";

const reportId = "10000000-0000-4000-8000-000000000001";
const siteId = "20000000-0000-4000-8000-000000000001";
const request: EnergyReportRequest = { from: "2026-09-07", to: "2026-09-08", scope: "site", identityId: siteId, format: "xlsx" };
const makeData = (): EnergyReportDataSnapshot => ({
  schemaVersion: 1, capturedAt: "2026-09-10T01:00:00.000Z",
  site: { id: siteId, name: "서울 현장", timeZone: "UTC" },
  comparisonRange: { from: "2026-09-05", to: "2026-09-06" },
  fixtures: [{
    id: "30000000-0000-4000-8000-000000000001", from: "2026-09-01", to: null,
    dimensions: [{ from: "2026-09-01", to: "2026-09-08", name: "조명 A", floorId: "floor-a", floorName: "1층" },
      { from: "2026-09-08", to: null, name: "조명 A 이동", floorId: "floor-b", floorName: "2층" }],
    groups: [{ id: "group-a", name: "통로", from: "2026-09-01", to: "2026-09-08" }],
    daily: [{ localDate: "2026-09-05", energyKwh: "0.1", cost: null, durationSeconds: 60 },
      { localDate: "2026-09-07", energyKwh: "0.2", cost: null, durationSeconds: 60 },
      { localDate: "2026-09-08", energyKwh: "0.1", cost: null, durationSeconds: 120 }],
    hourly: [{ bucketStartUtc: "2026-09-07T10:00:00.000Z", localDate: "2026-09-07", localHour: 10, energyKwh: "0.2", durationSeconds: 60, brightnessWeightedSeconds: "1200" },
      { bucketStartUtc: "2026-09-08T10:00:00.000Z", localDate: "2026-09-08", localHour: 10, energyKwh: "0.1", durationSeconds: 120, brightnessWeightedSeconds: "9600" }]
  }]
});
function table(document: EnergyReportDocument, id: string) {
  const section = document.sections.find((section) => section.kind === "table" && section.id === id);
  if (!section || section.kind !== "table") throw new Error(`Missing table ${id}`);
  return section.rows.map((row) => row.map((cell) => cell.value));
}

describe("EnergyReportDocumentBuilder", () => {
  const builder = new EnergyReportDocumentBuilder();

  it("validates only final document strings after scope, date and fact filtering", () => {
    const data = makeData();
    const retired = structuredClone(data.fixtures[0]);
    retired.id = "30000000-0000-4000-8000-000000000099";
    retired.from = "2025-01-01"; retired.to = "2025-12-31";
    retired.dimensions = [{ from: "2025-01-01", to: "2025-12-31", name: "Old\u00a0fixture", floorId: "old-floor", floorName: "Old floor" }];
    retired.daily = [{ localDate: "2025-09-07", energyKwh: "1", cost: "150", durationSeconds: 3600 }];
    retired.hourly = []; retired.groups = []; data.fixtures.push(retired);
    const document = builder.build(reportId, { ...request, scope: "fixture", identityId: data.fixtures[0].id }, data);
    expect(document.sections[0]).toMatchObject({ rows: [{ value: 0.3 }, { value: null }] });
    expect(JSON.stringify(document)).not.toContain("Old");
    expect(() => builder.build(reportId, { ...request, from: "2025-09-07", to: "2025-09-07", scope: "fixture", identityId: retired.id }, data))
      .toThrow(/Unsupported report/);
  });

  it("preserves authoritative site daily energy and cost before tracking and on the retirement day without inventing rankings", () => {
    const data = makeData();
    data.fixtures[0].from = "2026-09-08T03:00:00.000Z";
    data.fixtures[0].to = "2026-09-08T04:00:00.000Z";
    data.fixtures[0].dimensions = [];
    data.fixtures[0].groups = [];
    data.fixtures[0].hourly = [];
    data.fixtures[0].daily = [
      Object.assign({ localDate: "2026-09-07", energyKwh: "1.25", durationSeconds: 3600 }, { cost: "187.5" }),
      Object.assign({ localDate: "2026-09-08", energyKwh: "0", durationSeconds: 60 }, { cost: "0" })
    ];
    const document = builder.build(reportId, request, data);
    expect(document.sections[0]).toMatchObject({ rows: [{ value: 1.25 }, { value: 187.5 }] });
    expect(table(document, "daily")).toEqual([["2026-09-07", 1.25, 187.5], ["2026-09-08", 0, 0]]);
    for (const kind of ["fixture", "floor", "group"]) expect(table(document, `${kind}-ranking`)).toEqual([]);
  });

  it("compares persisted energy and costs without using a present tariff and leaves zero-denominator percentages absent", () => {
    const data = makeData();
    Object.assign(data.fixtures[0].daily[0], { cost: "0" });
    Object.assign(data.fixtures[0].daily[1], { cost: "30" });
    Object.assign(data.fixtures[0].daily[2], { cost: "20" });
    const document = builder.build(reportId, request, data);
    expect(table(document, "comparison")).toEqual([
      ["현재 기간", "2026-09-07 ~ 2026-09-08", 0.3, 50],
      ["직전 동일 일수", "2026-09-05 ~ 2026-09-06", 0.1, 0],
      ["차이", null, 0.2, 50], ["변화율", null, 200, null]
    ]);
    expect(JSON.stringify(document)).toContain("적용 요금 단가: 데이터 없음");
    expect(JSON.stringify(document)).not.toMatch(/상태 기반 추정|예상|추정|coverage|known|unknown|forecast|baseline|estimated/i);
  });

  it("uses persisted partial sums without extrapolation and orders all report sections", () => {
    const document = builder.build(reportId, request, makeData());
    expect(energyReportDocumentSchema.safeParse(document).success).toBe(true);
    expect(document.sections.map((section) => section.kind === "table" || section.kind === "heatmap" ? section.id : section.kind))
      .toEqual(["summary", "daily", "comparison", "fixture-ranking", "floor-ranking", "group-ranking", "energy-heatmap", "brightness-heatmap", "notes"]);
    expect(document.sections[0]).toMatchObject({ rows: [{ value: 0.3, displayValue: "0.3000 kWh" }, { value: null }] });
    expect(table(document, "daily")).toEqual([["2026-09-07", 0.2, null], ["2026-09-08", 0.1, null]]);
    expect(table(document, "comparison")).toEqual([["현재 기간", "2026-09-07 ~ 2026-09-08", 0.3, null], ["직전 동일 일수", "2026-09-05 ~ 2026-09-06", 0.1, null], ["차이", null, 0.2, null], ["변화율", null, 200, null]]);
    expect(table(document, "floor-ranking")).toEqual([[1, "floor-a", "1층", 0.2, null], [2, "floor-b", "2층", 0.1, null]]);
    expect(table(document, "group-ranking")).toEqual([[1, "group-a", "통로", 0.2, null]]);
    expect(table(document, "fixture-ranking")).toEqual([[1, "30000000-0000-4000-8000-000000000001", "조명 A 이동", 0.3, null]]);
    expect(JSON.stringify(document)).not.toMatch(/상태 기반 추정|예상|추정|coverage|known|unknown|forecast|baseline|estimated/i);
  });

  it("preserves absence separately from measured zero in every daily and heatmap cell", () => {
    const data = makeData();
    data.fixtures[0].daily = [{ localDate: "2026-09-08", energyKwh: "0", cost: null, durationSeconds: 60 }];
    data.fixtures[0].hourly = [{ bucketStartUtc: "2026-09-08T10:00:00.000Z", localDate: "2026-09-08", localHour: 10, energyKwh: "0", durationSeconds: 60, brightnessWeightedSeconds: "0" }];
    const document = builder.build(reportId, request, data);
    expect(table(document, "daily")).toEqual([["2026-09-07", null, null], ["2026-09-08", 0, null]]);
    expect(table(document, "comparison")[1][2]).toBeNull();
    expect(table(document, "comparison")[2][2]).toBeNull();
    for (const section of document.sections.filter((section) => section.kind === "heatmap")) {
      expect(section.cells[1 * 24 + 10]).toMatchObject({ value: null, displayValue: "데이터 없음" });
      expect(section.cells[2 * 24 + 10].value).toBe(0);
    }
    data.fixtures = [];
    expect(builder.build(reportId, request, data).sections[0]).toMatchObject({ rows: [{ value: null, displayValue: "데이터 없음" }, { value: null }] });
  });

  it("uses historical scope membership and duration-weighted brightness, including repeated DST hours", () => {
    const data = makeData();
    data.fixtures[0].hourly.push({ bucketStartUtc: "2026-09-07T11:00:00.000Z", localDate: "2026-09-07", localHour: 10, energyKwh: "0.4", durationSeconds: 180, brightnessWeightedSeconds: "14400" });
    const document = builder.build(reportId, { ...request, scope: "floor", identityId: "floor-a" }, data);
    expect(table(document, "daily")).toEqual([["2026-09-07", 0.2, null], ["2026-09-08", null, null]]);
    const heatmaps = document.sections.filter((section) => section.kind === "heatmap");
    expect(heatmaps[0].cells[34].value).toBe(0.6);
    expect(heatmaps[1].cells[34].value).toBe(65);
    expect(heatmaps[0].cells[58].value).toBeNull();
  });

  it("preserves site totals on retirement days but excludes ended group days", () => {
    const data = makeData();
    data.fixtures[0].to = "2026-09-08";
    expect(table(builder.build(reportId, request, data), "daily")).toEqual([["2026-09-07", 0.2, null], ["2026-09-08", 0.1, null]]);
    data.fixtures[0].to = null;
    expect(table(builder.build(reportId, { ...request, scope: "group", identityId: "group-a" }, data), "daily"))
      .toEqual([["2026-09-07", 0.2, null], ["2026-09-08", null, null]]);
  });

  it("hashes canonical JSON without the fingerprint and is independent of query order and export format", () => {
    const data = makeData();
    const original = structuredClone(data);
    const document = builder.build(reportId, request, data);
    const canonicalize = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
      return JSON.stringify(value);
    };
    const { contentFingerprint, ...payload } = document;
    expect(contentFingerprint).toBe(createHash("sha256").update(canonicalize(payload)).digest("hex"));
    expect(data).toEqual(original);
    data.fixtures[0].daily.reverse(); data.fixtures[0].dimensions.reverse(); data.fixtures[0].hourly.reverse();
    expect(builder.build(reportId, { ...request, format: "pdf" }, data)).toEqual(document);
    data.fixtures[0].daily[0].energyKwh = "10";
    expect(builder.build(reportId, request, data).contentFingerprint).not.toBe(contentFingerprint);
  });
});
