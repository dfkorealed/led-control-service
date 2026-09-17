import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ObservabilityModule } from "./observability.module";
import { ReadinessService } from "./readiness.service";
import { RequestContextMiddleware } from "./request-context.middleware";
import { StructuredLoggerService } from "./structured-logger.service";

describe("ObservabilityModule", () => {
  it("exports runtime services and marks readiness stopping during module shutdown", async () => {
    const destroyOrder: string[] = [];
    const dependency = (name: string, extra: Record<string, unknown> = {}) => ({
      probeReadiness: jest.fn(),
      onModuleDestroy: jest.fn(() => { destroyOrder.push(name); }),
      ...extra
    });
    const moduleRef = await Test.createTestingModule({ imports: [ObservabilityModule] })
      .overrideProvider(PrismaService).useValue(dependency("postgres"))
      .overrideProvider(RedisProvider).useValue(dependency("redis"))
      .overrideProvider(MqttService).useValue(dependency("mqtt", {
        stopInboundAndDrain: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined)
      }))
      .overrideProvider(ObjectStorageService).useValue(dependency("objectStorage"))
      .compile();

    const readiness = moduleRef.get(ReadinessService);
    expect(readiness).toBeInstanceOf(ReadinessService);
    expect(moduleRef.get(RequestContextMiddleware)).toBeInstanceOf(RequestContextMiddleware);
    expect(moduleRef.get(StructuredLoggerService)).toBeInstanceOf(StructuredLoggerService);
    const originalMarkStopping = readiness.onModuleDestroy.bind(readiness);
    const markStopping = jest.spyOn(readiness, "onModuleDestroy").mockImplementation(() => {
      destroyOrder.push("readiness");
      originalMarkStopping();
    });

    await moduleRef.close();

    expect(markStopping).toHaveBeenCalledTimes(1);
    // Nest does not guarantee cross-module onModuleDestroy ordering. The contract is
    // that readiness becomes terminally not-ready and every dependency is closed.
    expect(destroyOrder).toEqual(expect.arrayContaining(["readiness", "postgres", "redis", "mqtt", "objectStorage"]));
    await expect(readiness.check()).resolves.toMatchObject({
      status: "not_ready",
      checks: { postgres: "down", redis: "down", mqtt: "down", objectStorage: "down", cadConverter: "down" }
    });
  });
});
