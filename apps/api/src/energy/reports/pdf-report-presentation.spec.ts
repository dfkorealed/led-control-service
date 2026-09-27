import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot } from "./energy-report-document.builder";
import { buildPdfReportPresentation } from "./pdf-report-presentation";

const request = { from: "2026-09-07", to: "2026-09-08", scope: "site" as const,
  identityId: "20000000-0000-4000-8000-000000000001", format: "pdf" as const };
const reportId = "10000000-0000-4000-8000-000000000001";
const fixture = (): EnergyReportDataSnapshot["fixtures"][number] => ({
  id: "30000000-0000-4000-8000-000000000001", from: "2026-09-01T00:00:00.000Z", to: null,
  dimensions: [{ from: "2026-09-01T00:00:00.000Z", to: null, name: "조명 가", floorId: "floor-1", floorName: "1층", ratedWatt: "20" }],
  groups: [], daily: [
    { localDate: "2026-09-05", energyKwh: "0.10001", cost: "10", durationSeconds: 86400 },
    { localDate: "2026-09-06", energyKwh: "0.20002", cost: "20", durationSeconds: 86400 },
    { localDate: "2026-09-07", energyKwh: "0.30003", cost: "30", durationSeconds: 86400 },
    { localDate: "2026-09-08", energyKwh: "0", cost: "0", durationSeconds: 86400 }
  ], hourly: [{ bucketStartUtc: "2026-09-07T00:00:00.000Z", localDate: "2026-09-07", localHour: 0,
    energyKwh: "0.30003", durationSeconds: 3600, brightnessWeightedSeconds: "0" }]
});
const data = (): EnergyReportDataSnapshot => ({
  schemaVersion: 2, capturedAt: "2026-09-10T01:00:00.000Z",
  site: { id: request.identityId, name: "서울 현장", timeZone: "UTC", tariffKwhRate: "99999" },
  comparisonRange: { from: "2026-09-05", to: "2026-09-06" }, fixtures: [fixture()]
});
const present = (snapshot = data()) => buildPdfReportPresentation(new EnergyReportDocumentBuilder().build(reportId, request, snapshot));

describe("PDF report presentation", () => {
  it("uses exact persisted sums and keeps a complete zero day distinct from a missing day", () => {
    const result = present();
    expect(result.summary).toMatchObject({ current: { raw: "0.30003" }, previous: { raw: "0.30003" },
      difference: { raw: "0" }, storedCost: { raw: "30" }, comparisonAvailable: true });
    expect(result.daily.map(day => [day.date, day.energy.raw, day.completeness])).toEqual([
      ["2026-09-07", "0.30003", "complete"], ["2026-09-08", "0", "complete"]]);
    expect(result.monthly).toMatchObject([{ month: "2026-09", energy: { raw: "0.30003" } }]);
    expect(result.precision).toBe(4);
    expect(result.fixtures.topFive[0]).toMatchObject({ name: "조명 가", energy: { raw: "0.30003" } });
    expect(result.heatmap).toHaveLength(168);
    expect(result.heatmap.find(cell => cell.weekday === 1 && cell.hour === 0)?.energy.raw).toBe("0.30003");
    expect(result.heatmapCoverage).toBe("partial");
    expect(JSON.stringify(result)).not.toMatch(/30000000|99999|baseline|savings|brightness|identityId|raw\/display/);
  });

  it("refuses comparison when a current date has no record or only part of its expected time", () => {
    const missing = data(); missing.fixtures[0].daily = missing.fixtures[0].daily.filter(row => row.localDate !== "2026-09-08");
    const absent = present(missing);
    expect(absent.daily[1]).toMatchObject({ completeness: "missing", energy: { raw: null, text: "데이터 없음" } });
    expect(absent.summary).toMatchObject({ comparisonAvailable: false, difference: { raw: null, text: "비교 불가" } });
    const partial = data(); partial.fixtures[0].daily[2].durationSeconds = 3600;
    expect(present(partial).daily[0].completeness).toBe("partial");
    expect(present(partial).summary.comparisonAvailable).toBe(false);
  });

  it("applies the same complete-record rule to the previous period", () => {
    const snapshot = data(); snapshot.fixtures[0].daily[0].durationSeconds = 300;
    const result = present(snapshot);
    expect(result.summary).toMatchObject({ current: { raw: "0.30003" }, previous: { raw: "0.30003" },
      comparisonAvailable: false, difference: { raw: null } });
    expect(result.quality.previous).toMatchObject({ completeDays: 1, totalDays: 2 });
  });

  it("does not fill a partial stored cost with a current tariff", () => {
    const snapshot = data(); snapshot.fixtures[0].daily[3].cost = null;
    const result = present(snapshot);
    expect(result.summary.storedCost).toMatchObject({ raw: null, text: "데이터 없음" });
    expect(result.daily[1].cost.raw).toBeNull();
  });

  it("uses 23- and 25-hour local days when checking complete records", () => {
    const snapshot = data(); snapshot.site.timeZone = "America/New_York";
    snapshot.fixtures[0].from = "2026-01-01T00:00:00.000Z";
    snapshot.fixtures[0].dimensions[0].from = snapshot.fixtures[0].from;
    snapshot.fixtures[0].daily = [
      { localDate: "2026-03-08", energyKwh: "0", cost: "0", durationSeconds: 82800 },
      { localDate: "2026-11-01", energyKwh: "0", cost: "0", durationSeconds: 90000 }
    ];
    const builder = new EnergyReportDocumentBuilder();
    for (const [date, expected] of [["2026-03-08", 82800], ["2026-11-01", 90000]] as const) {
      const doc = builder.build(reportId, { ...request, from: date, to: date }, {
        ...snapshot, comparisonRange: { from: "2026-01-01", to: "2026-01-01" }
      });
      const result = buildPdfReportPresentation(doc);
      expect(result.daily[0]).toMatchObject({ completeness: "complete", expectedSeconds: expected });
    }
  });

  it("groups 62 complete daily rows into two monthly detail blocks without losing exact totals", () => {
    const snapshot = data();
    snapshot.fixtures[0].from = "2026-03-01T00:00:00.000Z";
    snapshot.fixtures[0].dimensions[0].from = snapshot.fixtures[0].from;
    snapshot.fixtures[0].daily = [];
    for (let day = new Date("2026-04-30T00:00:00.000Z"); day <= new Date("2026-08-31T00:00:00.000Z");
      day = new Date(day.getTime() + 86400000)) {
      snapshot.fixtures[0].daily.push({ localDate: day.toISOString().slice(0, 10), energyKwh: "0.125",
        cost: "2", durationSeconds: 86400 });
    }
    snapshot.comparisonRange = { from: "2026-04-30", to: "2026-06-30" };
    const document = new EnergyReportDocumentBuilder().build(reportId,
      { ...request, from: "2026-07-01", to: "2026-08-31" }, snapshot);
    const result = buildPdfReportPresentation(document);
    expect(result.daily).toHaveLength(62);
    expect(result.monthly.map(month => [month.month, "days" in month ? (month.days as unknown[]).length : -1, month.energy.raw])).toEqual([
      ["2026-07", 31, "3.875"], ["2026-08", 31, "3.875"]]);
    expect(result.summary).toMatchObject({ current: { raw: "7.75" }, previous: { raw: "7.75" },
      difference: { raw: "0" }, comparisonAvailable: true });
  });

  it("retains energy without a full-day floor or fixture name as an unassigned amount", () => {
    const snapshot = data();
    snapshot.fixtures[0].dimensions = [];
    const result = present(snapshot);
    expect(result.floors).toMatchObject({ rows: [], unassigned: { raw: "0.30003" } });
    expect(result.fixtures).toMatchObject({ topFive: [], unassigned: { raw: "0.30003" } });
    expect(result.notes.join(" ")).toContain("귀속 불가");
  });

  it("marks the heatmap complete only when every expected UTC hour is covered", () => {
    const snapshot = data();
    snapshot.fixtures[0].hourly = [];
    for (const date of ["2026-09-07", "2026-09-08"]) for (let hour = 0; hour < 24; hour++) {
      snapshot.fixtures[0].hourly.push({ bucketStartUtc: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`,
        localDate: date, localHour: hour, energyKwh: date === "2026-09-07" && hour === 0 ? "0.30003" : "0",
        durationSeconds: 3600, brightnessWeightedSeconds: "0" });
    }
    const result = present(snapshot);
    expect(result.heatmapCoverage).toBe("complete");
    expect(result.heatmap.find(cell => cell.weekday === 1 && cell.hour === 3)).toMatchObject({
      energy: { raw: "0" }, expectedSeconds: 3600, knownSeconds: 3600 });
  });

  it("does not label missing-period allocation buckets as known zero", () => {
    const absent = data();
    absent.fixtures[0].daily = absent.fixtures[0].daily.filter(row => row.localDate < request.from);
    const allMissing = present(absent);
    expect(allMissing.floors.unassigned).toMatchObject({ raw: null, text: "데이터 없음" });
    expect(allMissing.fixtures.other).toMatchObject({ raw: null, text: "데이터 없음" });
    const partlyMissing = data();
    partlyMissing.fixtures[0].daily = partlyMissing.fixtures[0].daily.filter(row => row.localDate !== request.to);
    const partial = present(partlyMissing);
    expect(partial.fixtures.other.raw).toBe("0");
    expect(partial.fixtures.other.text).toContain("부분 기록");
    expect(partial.summary.current).toMatchObject({ raw: null, text: "데이터 없음" });
  });

  it("shows positive energy below display resolution instead of a false zero", () => {
    const snapshot = data();
    snapshot.fixtures[0].daily[2].energyKwh = "0.000049";
    snapshot.fixtures[0].daily[3].energyKwh = "0.000049";
    const result = present(snapshot);
    expect(result.daily.map(day => day.energy.text)).toEqual(["< 0.0001 kWh", "< 0.0001 kWh"]);
    expect(result.monthly[0].energy).toMatchObject({ raw: "0.000098", text: "0.0001 kWh" });
  });

  it("does not claim complete hourly coverage from shifted UTC buckets in Asia/Kolkata", () => {
    const snapshot = data(); snapshot.site.timeZone = "Asia/Kolkata";
    snapshot.fixtures[0].hourly = [];
    snapshot.fixtures[0].daily = [{ localDate: "2026-09-07", energyKwh: "0", cost: "0", durationSeconds: 86400 }];
    for (let hour = 0; hour < 24; hour++) {
      const bucket = new Date(Date.parse("2026-09-06T19:00:00.000Z") + hour * 3600000);
      snapshot.fixtures[0].hourly.push({ bucketStartUtc: bucket.toISOString(), localDate: "2026-09-07",
        localHour: hour, energyKwh: "0", durationSeconds: 3600, brightnessWeightedSeconds: "0" });
    }
    const document = new EnergyReportDocumentBuilder().build(reportId,
      { ...request, to: request.from }, { ...snapshot, comparisonRange: { from: "2026-09-06", to: "2026-09-06" } });
    const result = buildPdfReportPresentation(document);
    expect(result.daily[0].completeness).toBe("complete");
    expect(result.heatmapCoverage).toBe("unknown");
  });

  it("compacts 1,000 fixtures across 62 days to one source row per fixture", () => {
    const snapshot = data();
    const dates = Array.from({ length: 124 }, (_, index) =>
      new Date(Date.parse("2026-04-30T00:00:00.000Z") + index * 86400000).toISOString().slice(0, 10));
    snapshot.fixtures = Array.from({ length: 1000 }, (_, index) => ({ ...fixture(), id: `fixture-${index}`,
      from: "2026-04-01T00:00:00.000Z",
      dimensions: [{ ...fixture().dimensions[0], from: "2026-04-01T00:00:00.000Z", name: `조명 ${index}` }], hourly: [],
      daily: dates.map(localDate => ({ localDate, energyKwh: "0.1", cost: "1", durationSeconds: 86400 })) }));
    snapshot.comparisonRange = { from: "2026-04-30", to: "2026-06-30" };
    const document = new EnergyReportDocumentBuilder().build(reportId,
      { ...request, from: "2026-07-01", to: "2026-08-31" }, snapshot);
    const facts = document.sections.find(section => section.kind === "table" && section.id === "pdf-source-facts");
    expect(facts?.kind === "table" ? facts.rows.length : -1).toBe(1000);
    const result = buildPdfReportPresentation(document);
    expect(result.summary.current.raw).toBe("6200");
    expect(result.fixtures.topFive[0].energy.raw).toBe("6.2");
  }, 120000);
});
