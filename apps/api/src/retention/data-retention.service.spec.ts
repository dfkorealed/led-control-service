import { Logger } from "@nestjs/common";
import { DataRetentionService } from "./data-retention.service";

describe("operational retention lifecycle", () => {
  const environment = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = environment; jest.restoreAllMocks(); jest.useRealTimers(); });

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
      event: "data_retention_sweep", status: "completed", deleted: { gatewayEvents: 2, sessions: 0, floorMapRevisions: 0 }
    }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(6);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(6);
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
      deleted: { gatewayEvents: 3, sessions: 0, floorMapRevisions: 0 }
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive database error");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.$executeRaw).toHaveBeenCalledTimes(5);
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
});
