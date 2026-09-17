import { ObservabilityMetrics } from "./observability-metrics.service";
import { ReadinessService } from "./readiness.service";

describe("ReadinessService", () => {
  const fixedNow = new Date("2026-09-12T00:00:00.000Z");

  function harness(overrides: Partial<Record<"postgres" | "redis" | "mqtt" | "objectStorage" | "cadConverter", () => Promise<void>>> = {}) {
    const probes = {
      postgres: jest.fn(overrides.postgres ?? (async () => undefined)),
      redis: jest.fn(overrides.redis ?? (async () => undefined)),
      mqtt: jest.fn(overrides.mqtt ?? (async () => undefined)),
      objectStorage: jest.fn(overrides.objectStorage ?? (async () => undefined)),
      cadConverter: jest.fn(overrides.cadConverter ?? (async () => undefined))
    };
    const metrics = new ObservabilityMetrics();
    const service = new ReadinessService(
      { probeReadiness: probes.postgres } as never,
      { probeReadiness: probes.redis } as never,
      { probeReadiness: probes.mqtt } as never,
      { probeReadiness: probes.objectStorage } as never,
      { probeReadiness: probes.cadConverter } as never,
      metrics,
      () => fixedNow,
      25
    );
    return { service, probes, metrics };
  }

  it("runs every existing dependency probe and returns a safe ready result", async () => {
    const { service, probes } = harness();

    await expect(service.check()).resolves.toEqual({
      status: "ready",
      checks: { postgres: "up", redis: "up", mqtt: "up", objectStorage: "up", cadConverter: "up" },
      timestamp: "2026-09-12T00:00:00.000Z"
    });
    Object.values(probes).forEach(probe => expect(probe).toHaveBeenCalledTimes(1));
  });

  it("maps caught dependency errors to generic down states without leaking them", async () => {
    const { service } = harness({
      redis: async () => { throw new Error("redis://admin:secret@private-host:6379 timed out"); }
    });

    const result = await service.check();

    expect(result).toEqual({
      status: "not_ready",
      checks: { postgres: "up", redis: "down", mqtt: "up", objectStorage: "up", cadConverter: "up" },
      timestamp: "2026-09-12T00:00:00.000Z"
    });
    expect(JSON.stringify(result)).not.toMatch(/admin|secret|private-host|timed out|stack/i);
  });

  it("bounds a probe that never settles", async () => {
    jest.useFakeTimers();
    try {
      const { service } = harness({ redis: () => new Promise<void>(() => undefined) });
      const pending = service.check();

      await jest.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toMatchObject({ status: "not_ready", checks: { redis: "down" } });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("coalesces calls after a timeout until raw probes settle, then allows recovery", async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const stalled = new Promise<void>(resolve => { release = resolve; });
      const redisProbe = jest.fn()
        .mockImplementationOnce(() => stalled)
        .mockResolvedValue(undefined);
      const { service, probes } = harness({ redis: redisProbe });
      const first = service.check();

      await jest.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toMatchObject({ status: "not_ready", checks: { redis: "down" } });
      await expect(service.check()).resolves.toMatchObject({ status: "not_ready", checks: { redis: "down" } });
      Object.values(probes).forEach(probe => expect(probe).toHaveBeenCalledTimes(1));

      release();
      jest.useRealTimers();
      await new Promise(resolve => setImmediate(resolve));
      await expect(service.check()).resolves.toMatchObject({ status: "ready", checks: { redis: "up" } });
      Object.values(probes).forEach(probe => expect(probe).toHaveBeenCalledTimes(2));
    } finally {
      jest.useRealTimers();
    }
  });

  it("treats Promise.reject(undefined) as a failed probe", async () => {
    const { service } = harness({ redis: () => Promise.reject(undefined) });

    await expect(service.check()).resolves.toMatchObject({
      status: "not_ready",
      checks: { redis: "down" }
    });
  });

  it("becomes not-ready before shutdown probes can perform dependency I/O", async () => {
    const { service, probes } = harness();

    service.onModuleDestroy();
    const result = await service.check();

    expect(result).toEqual({
      status: "not_ready",
      checks: { postgres: "down", redis: "down", mqtt: "down", objectStorage: "down", cadConverter: "down" },
      timestamp: "2026-09-12T00:00:00.000Z"
    });
    Object.values(probes).forEach(probe => expect(probe).not.toHaveBeenCalled());
  });
});
