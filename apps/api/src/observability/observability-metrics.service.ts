import { Injectable } from "@nestjs/common";
import type { DependencyChecks } from "./readiness.service";

const dependencyNames = ["postgres", "redis", "mqtt", "objectStorage"] as const;

@Injectable()
export class ObservabilityMetrics {
  private requestsTotal = 0;
  private responses4xxTotal = 0;
  private responses5xxTotal = 0;
  private latencyMsSum = 0;
  private latencyMsMax = 0;
  private readinessStatus: "ready" | "not_ready" = "not_ready";
  private readonly dependencyFailuresTotal: Record<(typeof dependencyNames)[number], number> = {
    postgres: 0,
    redis: 0,
    mqtt: 0,
    objectStorage: 0
  };

  recordHttp(statusCode: number, durationMs: number) {
    const boundedDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    this.requestsTotal += 1;
    if (statusCode >= 400 && statusCode < 500) this.responses4xxTotal += 1;
    if (statusCode >= 500 && statusCode < 600) this.responses5xxTotal += 1;
    this.latencyMsSum += boundedDuration;
    this.latencyMsMax = Math.max(this.latencyMsMax, boundedDuration);
  }

  recordReadiness(checks: DependencyChecks) {
    this.readinessStatus = dependencyNames.every(name => checks[name] === "up") ? "ready" : "not_ready";
    for (const name of dependencyNames) {
      if (checks[name] === "down") this.dependencyFailuresTotal[name] += 1;
    }
  }

  snapshot() {
    return {
      http: {
        requestsTotal: this.requestsTotal,
        responses4xxTotal: this.responses4xxTotal,
        responses5xxTotal: this.responses5xxTotal,
        latencyMsSum: this.latencyMsSum,
        latencyMsMax: this.latencyMsMax
      },
      readiness: {
        status: this.readinessStatus,
        dependencyFailuresTotal: { ...this.dependencyFailuresTotal }
      }
    };
  }
}
