import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit() {
    await this.$connect();
  }

  async onApplicationShutdown() {
    // Nest destroys imported modules before their consumers. Wait until every
    // onModuleDestroy drain has finished; otherwise a worker's remaining queries
    // can reopen Prisma after disconnect and leave a connection alive on close.
    await this.$disconnect();
  }
}
