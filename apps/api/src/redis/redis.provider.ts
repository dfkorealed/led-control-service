import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class RedisProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisProvider.name);
  private client: Redis | null = null;

  onModuleInit() {
    this.getClient();
  }

  getClient() {
    if (!this.client) {
      const client = new Redis(this.getRedisUrl());
      // ioredis writes an unhandled error and stack to stderr when no listener exists.
      // Consume the raw error at the client boundary and emit only a fixed classification.
      client.on("error", () => this.logger.error({ operation: "dependency", errorClass: "ConnectionError" }));
      this.client = client;
    }
    return this.client;
  }

  async onModuleDestroy() {
    const client = this.client;
    this.client = null;
    if (client) await client.quit();
  }

  async probeReadiness() {
    const client = this.client;
    if (!client) throw new Error("Redis client unavailable");
    const response = await client.ping();
    if (response !== "PONG") throw new Error("Redis client unavailable");
  }

  private getRedisUrl() {
    const url = process.env.REDIS_URL?.trim();
    if (!url) throw new Error("REDIS_URL is required");
    return url;
  }
}
