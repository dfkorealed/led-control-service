import { ObservabilityMetrics } from "./observability-metrics.service";

describe("ObservabilityMetrics", () => {
  it("uses only fixed bounded request and dependency labels", () => {
    const metrics = new ObservabilityMetrics();
    metrics.recordHttp(204, 4);
    metrics.recordHttp(404, 8);
    metrics.recordHttp(503, 12);
    metrics.recordReadiness({ postgres: "up", redis: "down", mqtt: "up", objectStorage: "down", cadConverter: "up" });

    expect(metrics.snapshot()).toEqual({
      http: {
        requestsTotal: 3,
        responses4xxTotal: 1,
        responses5xxTotal: 1,
        latencyMsSum: 24,
        latencyMsMax: 12
      },
      readiness: {
        status: "not_ready",
        dependencyFailuresTotal: { postgres: 0, redis: 1, mqtt: 0, objectStorage: 1, cadConverter: 0 }
      }
    });
  });
});
