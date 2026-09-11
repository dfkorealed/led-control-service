import { EnergyRetentionService } from "./energy-retention.service";

describe("EnergyRetentionService", () => {
  it("deletes only hourly buckets older than 24 UTC calendar months in a bounded batch", async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ id: "hour-1" }, { id: "hour-2" }]) };
    const service = new EnergyRetentionService(prisma as never);

    await expect(service.prune(new Date("2026-09-11T12:34:56.000Z"))).resolves.toBe(2);

    const query = prisma.$queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(query.strings.join("?")).toContain('DELETE FROM "FixtureEnergyHourlyAggregate"');
    expect(query.strings.join("?")).toContain('"bucketStartUtc" < ?');
    expect(query.strings.join("?")).toContain("LIMIT ?");
    expect(query.values).toContain(10_000);
    expect(query.values).toContainEqual(new Date("2024-09-11T12:34:56.000Z"));
  });

  it("does not install more than one retention timer", () => {
    jest.useFakeTimers();
    const service = new EnergyRetentionService({ $queryRaw: jest.fn().mockResolvedValue([]) } as never);
    const timerSpy = jest.spyOn(global, "setInterval");
    service.onModuleInit();
    service.onModuleInit();
    expect(timerSpy).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    jest.useRealTimers();
  });
});
