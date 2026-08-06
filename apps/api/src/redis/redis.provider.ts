import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class RedisProvider implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;

  onModuleInit() {
    this.getRedisUrl();
  }

  getClient() {
    if (!this.client) this.client = new Redis(this.getRedisUrl());
    return this.client;
  }

  async onModuleDestroy() {
    const client = this.client;
    this.client = null;
    if (client) await client.quit();
  }

  private getRedisUrl() {
    const url = process.env.REDIS_URL?.trim();
    if (!url) throw new Error("REDIS_URL is required");
    return url;
  }
}
