import { Prisma } from "@prisma/client";
import { splitEnergyIntervalByUtcHour } from "./energy-hourly-aggregation";

describe("splitEnergyIntervalByUtcHour", () => {
  it("splits known energy on UTC hour boundaries", () => {
    const result = splitEnergyIntervalByUtcHour({
      from: new Date("2026-09-10T00:30:00.000Z"),
      to: new Date("2026-09-10T02:15:00.000Z"),
      brightness: 60,
      ratedWatt: new Prisma.Decimal(100),
      timeZone: "Asia/Seoul",
      known: true
    });

    expect(result.map((item) => item.knownSeconds)).toEqual([1_800, 3_600, 900]);
    expect(result.map((item) => item.localHour)).toEqual([9, 10, 11]);
    expect(result.map((item) => item.utcOffsetMinutes)).toEqual([540, 540, 540]);
    expect(result.map((item) => item.estimatedKwh.toFixed(3))).toEqual(["0.030", "0.060", "0.015"]);
    expect(result.map((item) => item.brightnessWeightedSeconds.toString())).toEqual([
      "108000", "216000", "54000"
    ]);
  });

  it("stores unknown duration without energy or weighted brightness", () => {
    const [result] = splitEnergyIntervalByUtcHour({
      from: new Date("2026-09-10T00:00:00.000Z"),
      to: new Date("2026-09-10T00:02:00.000Z"),
      brightness: 100,
      ratedWatt: new Prisma.Decimal(40),
      timeZone: "UTC",
      known: false
    });

    expect(result).toMatchObject({ knownSeconds: 0, unknownSeconds: 120, localHour: 0, utcOffsetMinutes: 0 });
    expect(result.estimatedKwh.isZero()).toBe(true);
    expect(result.brightnessWeightedSeconds.isZero()).toBe(true);
  });

  it("distinguishes repeated local hours during DST fallback by UTC bucket and offset", () => {
    const result = splitEnergyIntervalByUtcHour({
      from: new Date("2026-11-01T05:00:00.000Z"),
      to: new Date("2026-11-01T07:00:00.000Z"),
      brightness: 50,
      ratedWatt: new Prisma.Decimal(20),
      timeZone: "America/New_York",
      known: true
    });

    expect(result.map((item) => [item.localDate.toISOString(), item.localHour, item.utcOffsetMinutes])).toEqual([
      ["2026-11-01T00:00:00.000Z", 1, -240],
      ["2026-11-01T00:00:00.000Z", 1, -300]
    ]);
    expect(result[0].bucketStartUtc).not.toEqual(result[1].bucketStartUtc);
  });
});
