import { expect, it } from "vitest";
import * as contracts from "./index";
import { spawnSync } from "node:child_process";
const c = contracts as unknown as Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
const accepts = (name: string, value: unknown) => c[name]?.safeParse(value).success ?? false;
const hash = `sha256:${"b".repeat(64)}`;
const dataset = { country: "KR", source: "kasi", year: 2026, revision: "2026-r1", fetchedAt: "2026-10-14T00:00:00.000Z",
  coverageFrom: "2026-01-01", coverageUntil: "2026-12-31", payloadHash: hash, dates: [{ date: "2026-10-09", names: ["한글날"] }] };
it("requires complete year coverage and valid unique holiday dates including empty datasets", () => {
  expect(accepts("holidayDatasetSnapshotSchema", dataset)).toBe(true);
  expect(accepts("holidayDatasetSnapshotSchema", { ...dataset, dates: [] })).toBe(true);
  for (const patch of [{ country: "US" }, { coverageFrom: "2026-02-01" }, { coverageUntil: "2027-01-01" },
    { payloadHash: "bad" }, { dates: [{ date: "2026-02-29", names: ["invalid"] }] }, { dates: [dataset.dates[0], dataset.dates[0]] },
    { dates: [{ date: "2027-01-01", names: ["wrong year"] }] }, { dates: [{ date: "2026-10-09", names: [] }] }, { incomplete: true }]) {
    expect(accepts("holidayDatasetSnapshotSchema", { ...dataset, ...patch })).toBe(false);
  }
});
it("limits complete calendar to inclusive 42 valid local dates and attributes occurrences", () => {
  const calendar = { from: "2026-10-01", to: "2026-11-11", timeZone: "Asia/Seoul", complete: true,
    revisionKey: hash, holidayCoverage: [dataset], schedules: [], occurrences: [] };
  expect(accepts("scheduleCalendarResponseSchema", calendar)).toBe(true);
  expect(accepts("scheduleCalendarResponseSchema", { ...calendar, to: calendar.from })).toBe(true);
  for (const patch of [{ to: "2026-11-12" }, { to: "2026-09-30" }, { from: "2026-02-30" }, { complete: false },
    { timeZone: "unknown" }, { revisionKey: "bad" }, { nextCursor: "partial" }, { occurrences: [{ scheduleId: "00000000-0000-4000-8000-000000000001", key: "unknown", localDate: "2026-10-01", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-01T01:00:00Z" }] }]) expect(accepts("scheduleCalendarResponseSchema", { ...calendar, ...patch })).toBe(false);
});
it("loads temporary and holiday package subpaths in direct Node ESM and CommonJS", () => {
  for (const mode of ["module", "commonjs"]) {
    const code = mode === "module"
      ? 'for (const name of ["temporary-control-contracts", "holiday-calendar-contracts"]) { const value = await import("@led-control/shared/"+name); if (!Object.values(value).some(entry => entry?.safeParse)) process.exit(2); }'
      : 'for (const name of ["temporary-control-contracts", "holiday-calendar-contracts"]) { const value = require("@led-control/shared/"+name); if (!Object.values(value).some(entry => entry?.safeParse)) process.exit(2); }';
    const result = spawnSync(process.execPath, ["--input-type=" + mode, "-e", code], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
});
