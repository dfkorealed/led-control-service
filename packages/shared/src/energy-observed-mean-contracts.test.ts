import { describe, expect, it } from "vitest";
import { energyObservedMeanQuerySchema, energyObservedMeanResponseSchema } from "./energy-observed-mean-contracts";

const query = {
  scope: "site", identityId: "00000000-0000-4000-8000-000000000001", metric: "energy",
  from: "2026-09-25", to: "2026-09-25"
};

const cells = Array.from({ length: 168 }, (_, index) => ({
  weekday: Math.floor(index / 24), hour: index % 24,
  value: index === 0 ? 0 : index === 1 ? null : 1.5,
  knownSeconds: index === 1 ? 0 : 3600,
  expectedSeconds: 3600,
  observedLocalDays: index === 1 ? 0 : 1,
  eligibleLocalDays: 1,
  coverageRate: index === 1 ? 0 : 1
}));
const response = {
  siteId: "00000000-0000-4000-8000-000000000001", timeZone: "Asia/Seoul",
  generatedAt: "2026-09-25T00:00:00.000Z", metric: "energy", scope: "site",
  identityId: "00000000-0000-4000-8000-000000000001",
  range: { from: "2026-09-01", to: "2026-09-02" }, cells
};

describe("observed mean heatmap response", () => {
  it("accepts one, 92, 93, and 400 calendar days while rejecting 401", () => {
    for (const from of ["2026-09-25", "2026-06-26", "2026-06-25", "2025-08-22"]) {
      expect(energyObservedMeanQuerySchema.safeParse({ ...query, from }).success).toBe(true);
    }
    expect(energyObservedMeanQuerySchema.safeParse({ ...query, from: "2025-08-21" }).success).toBe(false);
  });

  it("rejects malformed, reversed, mixed, and incomplete observed mean queries", () => {
    for (const invalid of [
      { ...query, from: "2026-02-30" },
      { ...query, from: "2026-09-26" },
      { ...query, preset: "current_month" },
      { ...query, metric: undefined },
      { ...query, identityId: "not-a-uuid" }
    ]) expect(energyObservedMeanQuerySchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps fully observed zero distinct from missing data", () => {
    expect(energyObservedMeanResponseSchema.parse(response).cells.slice(0, 2)).toEqual(cells.slice(0, 2));
    const absentHour = { ...cells[0], value: null, knownSeconds: 0, expectedSeconds: 0,
      observedLocalDays: 0, eligibleLocalDays: 0, coverageRate: null };
    expect(energyObservedMeanResponseSchema.safeParse({ ...response,
      cells: [absentHour, ...cells.slice(1)]
    }).success).toBe(true);
    expect(energyObservedMeanResponseSchema.safeParse({ ...response, cells: cells.slice(1) }).success).toBe(false);
    expect(energyObservedMeanResponseSchema.safeParse({ ...response, cells: [{ ...cells[0], payload: {} }, ...cells.slice(1)] }).success).toBe(false);
  });

  it("rejects duplicate or unordered cells and impossible coverage", () => {
    expect(energyObservedMeanResponseSchema.safeParse({ ...response, cells: [cells[1], cells[0], ...cells.slice(2)] }).success).toBe(false);
    expect(energyObservedMeanResponseSchema.safeParse({ ...response, cells: [{ ...cells[0], knownSeconds: 3601 }, ...cells.slice(1)] }).success).toBe(false);
  });

  it("rejects non-finite values, fractional or negative counts, and ranges over 400 days", () => {
    for (const invalidCell of [
      { ...cells[0], value: Number.POSITIVE_INFINITY },
      { ...cells[0], knownSeconds: -1 },
      { ...cells[0], eligibleLocalDays: 1.5 }
    ]) expect(energyObservedMeanResponseSchema.safeParse({ ...response, cells: [invalidCell, ...cells.slice(1)] }).success).toBe(false);
    expect(energyObservedMeanResponseSchema.safeParse({ ...response,
      range: { from: "2025-08-21", to: "2026-09-25" }
    }).success).toBe(false);
  });
});
