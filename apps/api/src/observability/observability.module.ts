import { Module } from "@nestjs/common";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { StorageModule } from "../storage/storage.module";
import { FloorImportModule } from "../floor-import/floor-import.module";
import { HealthController } from "./health.controller";
import { ObservabilityMetrics } from "./observability-metrics.service";
import {
  DEFAULT_READINESS_PROBE_TIMEOUT_MS,
  OBSERVABILITY_CLOCK,
  READINESS_PROBE_TIMEOUT_MS,
  ReadinessService
} from "./readiness.service";
import { OBSERVABILITY_HTTP_LOGGER, RequestContext, RequestContextMiddleware } from "./request-context.middleware";
import { STRUCTURED_LOG_WRITER, StructuredLoggerService } from "./structured-logger.service";

@Module({
  imports: [PrismaModule, RedisModule, MqttModule, StorageModule, FloorImportModule],
  controllers: [HealthController],
  providers: [
    ObservabilityMetrics,
    ReadinessService,
    RequestContext,
    RequestContextMiddleware,
    StructuredLoggerService,
    { provide: OBSERVABILITY_HTTP_LOGGER, useExisting: StructuredLoggerService },
    { provide: OBSERVABILITY_CLOCK, useValue: () => new Date() },
    { provide: READINESS_PROBE_TIMEOUT_MS, useValue: DEFAULT_READINESS_PROBE_TIMEOUT_MS },
    { provide: STRUCTURED_LOG_WRITER, useValue: (line: string) => process.stdout.write(line) }
  ],
  exports: [ReadinessService, RequestContext, RequestContextMiddleware, StructuredLoggerService]
})
export class ObservabilityModule {}
