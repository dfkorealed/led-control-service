jest.mock("ioredis", () => ({
  __esModule: true,
  default: jest.fn()
}));

import Redis from "ioredis";
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
    (Redis as unknown as jest.Mock).mockImplementation(() => ({ quit }));
    const provider = new RedisProvider();

    const first = provider.getClient();
    const second = provider.getClient();
    await provider.onModuleDestroy();

    expect(first).toBe(second);
    expect(Redis).toHaveBeenCalledWith("redis://redis.internal:6379/4");
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
