import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { FixtureIdentifyController } from "./fixture-identify.controller";
import { FixtureIdentifyService } from "./fixture-identify.service";

@Module({ imports: [AccessModule, AuditModule, AuthModule, MqttModule, PrismaModule, RedisModule],
  controllers: [FixtureIdentifyController], providers: [FixtureIdentifyService] })
export class FixtureIdentifyModule {}
