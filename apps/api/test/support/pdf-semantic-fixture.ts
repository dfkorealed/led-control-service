import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot } from "../../src/energy/reports/energy-report-document.builder";

const reportId = "10000000-0000-4000-8000-000000000001";
const siteId = "20000000-0000-4000-8000-000000000001";
const fixtureId = "30000000-0000-4000-8000-000000000001";

export function makePdfSemanticFixture(days = 62, incomplete = false, longName = false, allCurrentMissing = false, hugeCost = false,
  options: { scope?: "site" | "floor" | "group" | "fixture"; partialDay?: "partial" | "unknown"; sameNameTarget?: boolean } = {}) {
  const from = new Date("2026-07-01T00:00:00.000Z");
  const dates = Array.from({ length: days }, (_, index) => new Date(from.getTime() + index * 86400000).toISOString().slice(0, 10));
  const previous = Array.from({ length: days }, (_, index) => new Date(from.getTime() - (days - index) * 86400000).toISOString().slice(0, 10));
  const all = [...previous, ...dates];
  const data: EnergyReportDataSnapshot = {
    schemaVersion: 2, capturedAt: "2026-09-01T00:00:00.000Z",
    site: { id: siteId, name: longName ? "서울 생산동 긴 현장 이름 ".repeat(20) : "서울 현장", timeZone: "UTC", tariffKwhRate: "160" },
    comparisonRange: { from: previous[0], to: previous.at(-1)! },
    targetLabelSnapshot: options.sameNameTarget ? "서울 현장" : undefined,
    fixtures: [{ id: fixtureId, from: "2026-01-01T00:00:00.000Z", to: null,
      dimensions: [{ name: longName ? "아주 긴 한글 조명 이름 ".repeat(18) : "조명 가", floorId: "floor-1", floorName: "1층", ratedWatt: "30", from: "2026-01-01T00:00:00.000Z", to: null }], groups: [],
      daily: all.filter(date => previous.includes(date) || (!allCurrentMissing && (!incomplete || date !== dates[7]))).map(date => ({ localDate: date, energyKwh: "1.125",
        cost: hugeCost ? "9007199254740993.25" : "180", durationSeconds: date === dates[7] && options.partialDay
          ? options.partialDay === "partial" ? 3600 : 90000 : 86400 })),
      hourly: dates.filter(date => !allCurrentMissing && (!incomplete || date !== dates[7])).flatMap(date => Array.from({ length: 24 }, (_, hour) => ({
        localDate: date, localHour: hour, bucketStartUtc: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`,
        energyKwh: hour === 0 ? "1.125" : "0", durationSeconds: 3600, brightnessWeightedSeconds: "0" }))) }]
  };
  if (options.scope === "group") data.fixtures[0].groups = [{ id: "group-1", name: "서울 현장", from: "2026-01-01T00:00:00.000Z", to: null }];
  const scope = options.scope ?? "site";
  const identityId = { site: siteId, floor: "floor-1", group: "group-1", fixture: fixtureId }[scope];
  return new EnergyReportDocumentBuilder().build(reportId,
    { scope, identityId, format: "pdf", from: dates[0], to: dates.at(-1)! }, data);
}

/** One complete current day across many ordinary floors; exercises attribution pagination without a large source table. */
export function makePdfManyFloorsFixture(floorCount: number) {
  const current = "2026-07-01", previous = "2026-06-30";
  const fixtures: EnergyReportDataSnapshot["fixtures"] = Array.from({ length: floorCount }, (_, index) => ({
    id: `floor-fixture-${index + 1}`, from: "2026-01-01T00:00:00.000Z", to: null,
    dimensions: [{ name: `조명 ${index + 1}`, floorId: `floor-${index + 1}`, floorName: `${index + 1}층`, ratedWatt: "30",
      from: "2026-01-01T00:00:00.000Z", to: null }], groups: [],
    daily: [previous, current].map(localDate => ({ localDate, energyKwh: "1.125", cost: "180", durationSeconds: 86400 })),
    hourly: Array.from({ length: 24 }, (_, hour) => ({ localDate: current, localHour: hour,
      bucketStartUtc: `${current}T${String(hour).padStart(2, "0")}:00:00.000Z`, energyKwh: hour === 0 ? "1.125" : "0",
      durationSeconds: 3600, brightnessWeightedSeconds: "0" }))
  }));
  return new EnergyReportDocumentBuilder().build(reportId,
    { scope: "site", identityId: siteId, format: "pdf", from: current, to: current },
    { schemaVersion: 2, capturedAt: "2026-07-02T00:00:00.000Z",
      site: { id: siteId, name: "다층 현장", timeZone: "UTC", tariffKwhRate: "160" },
      comparisonRange: { from: previous, to: previous }, fixtures });
}

/** Visual QA: two floors, six fixtures, variable daily usage and 24 hourly
 * observations per current day. The sixth fixture must appear in "other". */
export function makePdfRichFixture() {
  const from = new Date("2026-07-01T00:00:00.000Z");
  const dates = Array.from({ length: 62 }, (_, index) => new Date(from.getTime() + index * 86400000).toISOString().slice(0, 10));
  const previous = Array.from({ length: 62 }, (_, index) => new Date(from.getTime() - (62 - index) * 86400000).toISOString().slice(0, 10));
  const hourlyMilli = (fixture: number, day: number, hour: number) =>
    (fixture + 1) * 8 + (hour >= 8 && hour < 20 ? 28 : 0) + (day % 7 < 5 ? 12 : 0) + day % 5 * 3;
  const fixtures: EnergyReportDataSnapshot["fixtures"] = Array.from({ length: 6 }, (_, fixture) => {
    const daily = [...previous, ...dates].map((date, index) => {
      const milli = Array.from({ length: 24 }, (_, hour) => hourlyMilli(fixture, index % 62, hour)).reduce((a, b) => a + b, 0);
      return { localDate: date, energyKwh: (milli / 1000).toFixed(3), cost: String(Math.round(milli * 0.16)), durationSeconds: 86400 };
    });
    const hourly = dates.flatMap((date, day) => Array.from({ length: 24 }, (_, hour) => ({
      localDate: date, localHour: hour, bucketStartUtc: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`,
      energyKwh: (hourlyMilli(fixture, day, hour) / 1000).toFixed(3), durationSeconds: 3600, brightnessWeightedSeconds: "0"
    })));
    return { id: `rich-fixture-${fixture}`, from: "2026-01-01T00:00:00.000Z", to: null,
      dimensions: [{ name: `조명 L-${String(fixture + 1).padStart(3, "0")}`, floorId: fixture < 3 ? "basement" : "ground",
        floorName: fixture < 3 ? "B1" : "1F", ratedWatt: "50", from: "2026-01-01T00:00:00.000Z", to: null }],
      groups: [], daily, hourly };
  });
  return new EnergyReportDocumentBuilder().build(reportId,
    { scope: "site", identityId: siteId, format: "pdf", from: dates[0], to: dates.at(-1)! },
    { schemaVersion: 2, capturedAt: "2026-09-01T00:00:00.000Z",
      site: { id: siteId, name: "서울 생산동", timeZone: "UTC", tariffKwhRate: "160" },
      comparisonRange: { from: previous[0], to: previous.at(-1)! }, fixtures });
}
