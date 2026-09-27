import { Logger } from "@nestjs/common";
import { DataRetentionService } from "./data-retention.service";

describe("operational retention lifecycle", () => {
  const environment = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = environment; jest.restoreAllMocks(); jest.useRealTimers(); });

  it.each([
    { counts: [0, 0, 0], remaining: 1000 },
    { counts: [10000, 10000, 995], remaining: 5 },
    { counts: [10000, 10000, 1000], remaining: 0 }
  ])("limits monitoring refresh cleanup to the existing sweep budget: $remaining", async ({ counts, remaining }) => {
    const execute = jest.fn();
    for (const count of counts) execute.mockResolvedValueOnce(count);
    execute.mockResolvedValue(remaining);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    const result = await new DataRetentionService({ $executeRaw: execute } as never)
      .prune(new Date("2026-09-15T08:00:00.000Z"));
    expect(result).toMatchObject({ monitoringRefreshes: remaining });
    expect(execute).toHaveBeenCalledTimes(remaining === 0 ? 4 : 5);
    if (remaining > 0) {
      const query = execute.mock.calls[3][0];
      expect(query.values).toContainEqual(new Date("2026-09-08T08:00:00.000Z"));
      expect(query.values).toContain(remaining);
    }
    expect(execute.mock.calls.at(-1)?.[0].values).toContainEqual(new Date("2026-06-15T08:00:00.000Z"));
  });

  it("uses an unreferenced timer, skips overlapping ticks and stops on destruction", async () => {
    jest.useFakeTimers();
    process.env.NODE_ENV = "production";
    const interval = jest.spyOn(global, "setInterval");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const db = { $executeRaw: jest.fn().mockImplementationOnce(() => pending.then(() => 2)).mockResolvedValue(0) };
    const service = new DataRetentionService(db as never);
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    service.onModuleInit();
    service.onModuleInit();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "data_retention_sweep", status: "completed", deleted: { gatewayEvents: 2, sessions: 0, floorMapRevisions: 0, monitoringRefreshes: 0, monitoringActivities: 0, resolvedCommandRecoveries: 0 }
    }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(10);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(10);
  });

  it("logs partial counts without raw errors and retries after a failed tick", async () => {
    jest.useFakeTimers();
    process.env.NODE_ENV = "production";
    const db = { $executeRaw: jest.fn().mockResolvedValueOnce(3).mockRejectedValueOnce(new Error("sensitive database error")).mockResolvedValue(0) };
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    const service = new DataRetentionService(db as never);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "data_retention_sweep", status: "failed", failedStage: "sessions",
      deleted: { gatewayEvents: 3, sessions: 0, floorMapRevisions: 0, monitoringRefreshes: 0, monitoringActivities: 0, resolvedCommandRecoveries: 0 }
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive database error");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(7);
    await service.onModuleDestroy();
  });

  it("drains an in-flight sweep before module destruction completes", async () => {
    let release!: () => void;
    const db = { $executeRaw: jest.fn().mockImplementationOnce(() => new Promise<number>(resolve => { release = () => resolve(0); })).mockResolvedValue(0) };
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    const service = new DataRetentionService(db as never);
    const sweep = service.prune();
    let destroyed = false;
    const destruction = service.onModuleDestroy().then(() => { destroyed = true; });
    await Promise.resolve();
    expect(destroyed).toBe(false);
    release();
    await sweep;
    await destruction;
    expect(destroyed).toBe(true);
  });

  it("rejects production activation before startup or a manual sweep can delete anything", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env.RESOLVED_COMMAND_RECOVERY_RETENTION_ENABLED;
    const previousOptIn = process.env.DATA_RETENTION_TEST;
    const execute = jest.fn().mockResolvedValue(0);
    const service = new DataRetentionService({ $executeRaw: execute } as never);
    process.env.NODE_ENV = "production";
    process.env.DATA_RETENTION_TEST = "1";
    process.env.RESOLVED_COMMAND_RECOVERY_RETENTION_ENABLED = "1";
    try {
      expect(() => service.onModuleInit()).toThrow("resolved recovery summary retention is not certified");
      await expect(service.prune()).rejects.toThrow("resolved recovery summary retention is not certified");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousOptIn === undefined) delete process.env.DATA_RETENTION_TEST;
      else process.env.DATA_RETENTION_TEST = previousOptIn;
      if (previousFlag === undefined) delete process.env.RESOLVED_COMMAND_RECOVERY_RETENTION_ENABLED;
      else process.env.RESOLVED_COMMAND_RECOVERY_RETENTION_ENABLED = previousFlag;
    }
  });
});
