import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MonitoringIncidentsController } from "./monitoring-incidents.controller";
import { MonitoringIncidentsService } from "./monitoring-incidents.service";

@Module({
  imports: [PrismaModule, AccessModule, AuthModule, AuditModule],
  controllers: [MonitoringIncidentsController], providers: [MonitoringIncidentsService], exports: [MonitoringIncidentsService]
})
export class MonitoringIncidentsModule {}
