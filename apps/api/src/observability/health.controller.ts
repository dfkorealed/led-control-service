import { Controller, Get, Res } from "@nestjs/common";
import { ObservabilityMetrics } from "./observability-metrics.service";
import { ReadinessService } from "./readiness.service";

interface StatusResponse {
  status(code: number): unknown;
}

@Controller("health")
export class HealthController {
  constructor(
    private readonly readiness: ReadinessService,
    private readonly metrics: ObservabilityMetrics
  ) {}

  @Get("live")
  live() {
    return { status: "live" as const };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: StatusResponse) {
    const result = await this.readiness.check();
    if (result.status === "not_ready") response.status(503);
    return result;
  }

  @Get("metrics")
  metricsSnapshot() {
    return this.metrics.snapshot();
  }

}
