import { createHash } from "node:crypto";
import { energyReportDocumentSchema, type EnergyReportRequest, type EnergyReportDocument } from "@led-control/shared";
import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot } from "./energy-report-document.builder";

const reportId = "10000000-0000-4000-8000-000000000001";
const siteId = "20000000-0000-4000-8000-000000000001";
const request: EnergyReportRequest = { from: "2026-09-07", to: "2026-09-08", scope: "site", identityId: siteId, format: "pdf" };
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

  const kpiData = () => ({
    ...makeData(), schemaVersion: 2,
    site: { id: siteId, name: "서울 현장", timeZone: "Asia/Seoul", tariffKwhRate: "160" },
    fixtures: [0, 1].map(index => ({
      id: `fixture-${index}`, from: "2026-08-01T00:00:00Z", to: null,
      dimensions: [{ from: "2026-08-01T00:00:00Z", to: null as string | null, name: "조명", floorId: "floor-a", floorName: "1층", ratedWatt: "40" }],
      groups: [], hourly: [], daily: Array.from({ length: 10 }, (_, i) => ({
        localDate: `2026-09-${String(i + 1).padStart(2, "0")}`, energyKwh: "0.6", cost: "90", durationSeconds: 77760
      }))
    }))
  });
  const kpiRequest = { ...request, from: "2026-09-01", to: "2026-09-10" };
  const buildKpis = (data = kpiData(), selected = kpiRequest) => builder.build(reportId, selected, data as unknown as EnergyReportDataSnapshot);
  const summary = (document: EnergyReportDocument) => {
    const section = document.sections[0];
    if (section.kind !== "summary") throw new Error("Missing summary");
    return Object.fromEntries(section.rows.map(row => [row.label, row]));
  };

  it("captures selected-period v2 KPIs without repricing stored actual cost", () => {
    const document = buildKpis();
    expect(document.schemaVersion).toBe(2);
    expect(summary(document)).toMatchObject({
      "사용 전력량": { value: 12, source: "persisted_actual" }, "저장 비용": { value: 1800, source: "persisted_actual" },
      "24시간 기준 전력량": { value: 19.2, displayValue: "19.2000 kWh", source: "captured_current_configuration" },
      "절감 전력량": { value: 7.2 }, "예상 절감 비용": { value: 1152 }, "절감률": { value: 37.5 }, "데이터 수집률": { value: 90 }
    });
    expect(document).toMatchObject({ calculationBasis: { expectedSeconds: 1728000, knownSeconds: 1555200, fixtureCount: 2, tariffKwhRate: "160" } });
    expect(table(document, "daily")[0]).toEqual(["2026-09-01", 1.2, 180, 1.92]);
  });

  it("integrates intra-day scope and watt history without fabricating known seconds", () => {
    const data = kpiData(); data.fixtures = [data.fixtures[0]];
    data.fixtures[0].dimensions = [
      { ...data.fixtures[0].dimensions[0], to: "2026-09-01T03:00:00Z", floorId: "other" },
      { ...data.fixtures[0].dimensions[0], from: "2026-09-01T03:00:00Z", to: "2026-09-01T09:00:00Z" },
      { ...data.fixtures[0].dimensions[0], from: "2026-09-01T09:00:00Z", ratedWatt: "80" }
    ];
    const document = buildKpis(data, { ...kpiRequest, to: "2026-09-01", scope: "floor", identityId: "floor-a" });
    expect(document).toMatchObject({ calculationBasis: { expectedSeconds: 43200, knownSeconds: null, coverageReason: "scope_attribution_unavailable" } });
    expect(summary(document)).toMatchObject({ "24시간 기준 전력량": { value: 0.72 }, "데이터 수집률": { value: null } });
  });

  it.each([["2026-03-08", 82800, 0.92], ["2026-11-01", 90000, 1]])("uses actual DST day seconds on %s", (date, seconds, baseline) => {
    const data = kpiData(); data.site.timeZone = "America/New_York"; data.fixtures = [data.fixtures[0]];
    data.fixtures[0].from = "2026-01-01T00:00:00Z"; data.fixtures[0].dimensions[0].from = data.fixtures[0].from;
    const document = buildKpis(data, { ...kpiRequest, from: date as string, to: date as string });
    expect(document).toMatchObject({ calculationBasis: { expectedSeconds: seconds } });
    expect(summary(document)["24시간 기준 전력량"].value).toBe(baseline);
  });

  it("keeps null actual, missing tariff/history, zero baseline and over-baseline distinct", () => {
    const missing = kpiData(); missing.fixtures.forEach(fixture => fixture.daily = []);
    expect(summary(buildKpis(missing))["절감 전력량"].value).toBeNull();
    const noTariff = kpiData(); Object.assign(noTariff.site, { tariffKwhRate: null });
    expect(summary(buildKpis(noTariff))["예상 절감 비용"].value).toBeNull();
    const gap = kpiData(); gap.fixtures[0].dimensions = [];
    expect(summary(buildKpis(gap))["24시간 기준 전력량"].value).toBeNull();
    const zero = kpiData(); zero.fixtures.forEach(fixture => fixture.dimensions[0].ratedWatt = "0");
    expect(summary(buildKpis(zero))["기준 초과율"].value).toBeNull();
    const over = kpiData(); over.fixtures.forEach(fixture => fixture.daily.forEach(row => row.energyKwh = "1.2"));
    expect(summary(buildKpis(over))).toMatchObject({ "기준 초과 전력량": { value: -4.8 }, "예상 기준 초과 비용": { value: -768 }, "기준 초과율": { value: -25 } });
  });

  it("fingerprints captured tariff and visualization refs and caps coverage without extrapolating actuals", () => {
    const data = kpiData();
    data.fixtures.forEach(fixture => fixture.daily.forEach(row => row.durationSeconds = 90000));
    const document = buildKpis(data);
    expect(summary(document)["데이터 수집률"].value).toBe(100);
    const { contentFingerprint, ...input } = document;
    const canonicalize = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
      return JSON.stringify(value);
    };
    expect(contentFingerprint).toBe(createHash("sha256").update(canonicalize(input)).digest("hex"));
    const changed = structuredClone(input);
    const daily = changed.sections[1];
    if (!("visualization" in daily) || !daily.visualization) throw new Error("Missing visual reference");
    daily.visualization.id += "-changed";
    expect(createHash("sha256").update(canonicalize(changed)).digest("hex")).not.toBe(contentFingerprint);
    data.site.tariffKwhRate = "180";
    expect(buildKpis(data).contentFingerprint).not.toBe(contentFingerprint);
    expect(summary(buildKpis(data))["저장 비용"].value).toBe(1800);
  });

  it("does not claim a zero baseline for legacy facts that predate captured lifecycle history", () => {
    const data = kpiData(); data.fixtures.forEach(fixture => {
      fixture.from = "2026-09-15T00:00:00Z";
      fixture.dimensions[0].from = fixture.from;
    });
    const document = buildKpis(data);
    expect(summary(document)["사용 전력량"].value).toBe(12);
    expect(summary(document)["24시간 기준 전력량"].value).toBeNull();
    expect(document).toMatchObject({ calculationBasis: { baselineReason: "dimension_history_missing", knownSeconds: null } });
  });

  it("uses captured group membership once even when group name history is absent or duplicated", () => {
    const data = kpiData(); data.fixtures = [data.fixtures[0]];
    Object.assign(data.fixtures[0], { memberships: [
      { id: "selected-group", from: "2026-08-01T00:00:00Z", to: null },
      { id: "selected-group", from: "2026-08-01T00:00:00Z", to: null }
    ] });
    const document = buildKpis(data, { ...kpiRequest, scope: "group", identityId: "selected-group" });
    expect(summary(document)).toMatchObject({ "사용 전력량": { value: 6 }, "24시간 기준 전력량": { value: 9.6 }, "데이터 수집률": { value: 90 } });
    expect(document).toMatchObject({ calculationBasis: { expectedSeconds: 864000, fixtureCount: 1 } });
  });

  it.each(["site", "fixture", "group", "floor"] as const)("preserves attributable %s actuals and coverage when only baseline configuration is missing", scope => {
    const data = kpiData(); data.fixtures = [data.fixtures[0]];
    const fixture = data.fixtures[0];
    Object.assign(fixture, { memberships: [{ id: "selected-group", from: fixture.from, to: null }] });
    if (scope === "floor") Reflect.deleteProperty(fixture.dimensions[0], "ratedWatt");
    else fixture.dimensions = [];
    const identityId = { site: siteId, fixture: fixture.id, group: "selected-group", floor: "floor-a" }[scope];
    const document = buildKpis(data, { ...kpiRequest, to: "2026-09-01", scope, identityId });
    expect(summary(document)).toMatchObject({
      "사용 전력량": { value: 0.6, source: "persisted_actual" }, "저장 비용": { value: 90, source: "persisted_actual" },
      "24시간 기준 전력량": { value: null }, "절감 전력량": { value: null }, "절감률": { value: null },
      "현재 단가 기준 비용": { value: null }, "예상 절감 비용": { value: null }, "데이터 수집률": { value: 90 }
    });
    expect(table(document, "daily")).toEqual([["2026-09-01", 0.6, 90, null]]);
    expect(document).toMatchObject({ calculationBasis: {
      expectedSeconds: 86400, knownSeconds: 77760, baselineReason: "dimension_history_missing", coverageReason: null
    } });
  });

  it.each(["site", "fixture"] as const)("keeps %s tracking-start-day actuals but rejects comparisons against only the post-start interval", scope => {
    const data = kpiData(); data.fixtures = [data.fixtures[0]];
    const fixture = data.fixtures[0]; fixture.from = "2026-09-01T03:00:00Z"; fixture.dimensions[0].from = fixture.from;
    const document = buildKpis(data, { ...kpiRequest, to: "2026-09-01", scope, identityId: scope === "site" ? siteId : fixture.id });
    expect(summary(document)).toMatchObject({
      "사용 전력량": { value: 0.6 }, "저장 비용": { value: 90 }, "24시간 기준 전력량": { value: null },
      "절감 전력량": { value: null }, "절감률": { value: null }, "현재 단가 기준 비용": { value: null },
      "예상 절감 비용": { value: null }, "데이터 수집률": { value: null }
    });
    expect(table(document, "daily")).toEqual([["2026-09-01", 0.6, 90, null]]);
    expect(document).toMatchObject({ calculationBasis: {
      expectedSeconds: null, knownSeconds: null, baselineReason: "dimension_history_missing", coverageReason: "dimension_history_missing"
    } });
  });

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
      if (section.kind !== "heatmap") throw new Error("Missing heatmap");
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
    if (heatmaps[0].kind !== "heatmap" || heatmaps[1].kind !== "heatmap") throw new Error("Missing heatmap");
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
