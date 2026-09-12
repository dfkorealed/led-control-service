import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { HealthController } from "./health.controller";
import { ObservabilityMetrics } from "./observability-metrics.service";
import { ReadinessService, type ReadinessResult } from "./readiness.service";

describe("HealthController HTTP boundary", () => {
  let app: INestApplication;
  let baseUrl: string;
  const readiness = { check: jest.fn<Promise<ReadinessResult>, []>() };
  const metrics = { snapshot: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: ReadinessService, useValue: readiness },
        { provide: ObservabilityMetrics, useValue: metrics }
      ]
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it("keeps liveness independent from every dependency probe", async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "live" });
    expect(readiness.check).not.toHaveBeenCalled();
    expect(metrics.snapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["ready", 200],
    ["not_ready", 503]
  ] as const)("returns %s using only the public readiness fields", async (status, expectedStatus) => {
    readiness.check.mockResolvedValueOnce({
      status,
      checks: { postgres: "up", redis: "up", mqtt: status === "ready" ? "up" : "down", objectStorage: "up" },
      timestamp: "2026-09-12T00:00:00.000Z"
    });

    const response = await fetch(`${baseUrl}/health/ready`);
    const body = await response.json();

    expect(response.status).toBe(expectedStatus);
    expect(body).toEqual({
      status,
      checks: { postgres: "up", redis: "up", mqtt: status === "ready" ? "up" : "down", objectStorage: "up" },
      timestamp: "2026-09-12T00:00:00.000Z"
    });
    expect(Object.keys(body).sort()).toEqual(["checks", "status", "timestamp"]);
    expect(JSON.stringify(body)).not.toMatch(/secret|credential|url|stack|timed out/i);
  });

  it("exposes only the bounded in-memory metrics snapshot", async () => {
    metrics.snapshot.mockReturnValueOnce({
      http: { requestsTotal: 3, responses4xxTotal: 1, responses5xxTotal: 1, latencyMsSum: 24, latencyMsMax: 12 },
      readiness: {
        status: "not_ready",
        dependencyFailuresTotal: { postgres: 0, redis: 1, mqtt: 0, objectStorage: 1 }
      }
    });

    const response = await fetch(`${baseUrl}/health/metrics`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      http: { requestsTotal: 3, responses4xxTotal: 1, responses5xxTotal: 1, latencyMsSum: 24, latencyMsMax: 12 },
      readiness: {
        status: "not_ready",
        dependencyFailuresTotal: { postgres: 0, redis: 1, mqtt: 0, objectStorage: 1 }
      }
    });
  });
});
