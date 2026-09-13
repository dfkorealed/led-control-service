jest.mock("ioredis", () => ({
  __esModule: true,
  default: jest.fn()
}));

import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { EventEmitter } from "node:events";
import { RedisProvider } from "./redis.provider";

describe("RedisProvider", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(async () => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    jest.clearAllMocks();
  });

  it("rejects startup use without the required REDIS_URL", () => {
    delete process.env.REDIS_URL;

    expect(() => new RedisProvider().getClient()).toThrow("REDIS_URL is required");
  });

  it("creates one client lazily and quits it during Nest shutdown", async () => {
    process.env.REDIS_URL = "redis://redis.internal:6379/4";
    const quit = jest.fn().mockResolvedValue("OK");
    (Redis as unknown as jest.Mock).mockImplementation(() => ({ quit, on: jest.fn() }));
    const provider = new RedisProvider();

    const first = provider.getClient();
    const second = provider.getClient();
    await provider.onModuleDestroy();

    expect(first).toBe(second);
    expect(Redis).toHaveBeenCalledWith("redis://redis.internal:6379/4");
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("creates the single production client during module initialization for readiness", () => {
    process.env.REDIS_URL = "redis://redis.internal:6379/4";
    (Redis as unknown as jest.Mock).mockImplementation(() => ({ quit: jest.fn(), on: jest.fn() }));
    const provider = new RedisProvider();

    provider.onModuleInit();

    expect(Redis).toHaveBeenCalledTimes(1);
    expect(Redis).toHaveBeenCalledWith("redis://redis.internal:6379/4");
  });

  it("handles existing-client errors once with a generic structured classification", async () => {
    process.env.REDIS_URL = "redis://redis.internal:6379/4";
    const client = Object.assign(new EventEmitter(), { quit: jest.fn().mockResolvedValue("OK") });
    (Redis as unknown as jest.Mock).mockImplementation(() => client);
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const provider = new RedisProvider();

    try {
      provider.onModuleInit();
      provider.getClient();
      expect(client.listenerCount("error")).toBe(1);

      client.emit("error", new Error("redis://admin:redis-secret@private-host:6379\nstack-secret"));

      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith({ operation: "dependency", errorClass: "ConnectionError" });
      expect(JSON.stringify(loggerError.mock.calls)).not.toMatch(/admin|redis-secret|private-host|stack-secret/);
    } finally {
      loggerError.mockRestore();
      await provider.onModuleDestroy();
    }
  });
});
