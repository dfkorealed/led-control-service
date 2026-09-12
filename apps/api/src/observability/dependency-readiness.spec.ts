jest.mock("ioredis", () => ({ __esModule: true, default: jest.fn() }));

import { HeadBucketCommand } from "@aws-sdk/client-s3";
import Redis from "ioredis";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { ObjectStorageService } from "../storage/object-storage.service";

describe("existing dependency readiness probes", () => {
  it("checks PostgreSQL with SELECT 1 on the existing Prisma client", async () => {
    const prisma = Object.create(PrismaService.prototype) as PrismaService;
    const query = jest.fn().mockResolvedValue([{ "?column?": 1 }]);
    (prisma as any).$queryRawUnsafe = query;

    await prisma.probeReadiness();

    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("PINGs only an already-created Redis client and never creates one from readiness", async () => {
    const provider = new RedisProvider();

    await expect(provider.probeReadiness()).rejects.toThrow("unavailable");
    expect(Redis).not.toHaveBeenCalled();

    const ping = jest.fn().mockResolvedValue("PONG");
    (provider as any).client = { ping };
    await provider.probeReadiness();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("reads MQTT connection state without creating or reconnecting a client", async () => {
    const service = new MqttService({} as never, {} as never);

    await expect(service.probeReadiness()).rejects.toThrow("unavailable");

    (service as any).client = { connected: true };
    await expect(service.probeReadiness()).resolves.toBeUndefined();
  });

  it("HEADs the configured bucket through the existing Object Storage client", async () => {
    const send = jest.fn().mockResolvedValue({});
    const service = new ObjectStorageService({ send } as never, {
      bucket: "floor-assets",
      publicBaseUrl: "https://assets.example"
    });

    await service.probeReadiness();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: "floor-assets" });
  });
});
