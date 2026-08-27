import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OperatorSiteAdminsController } from "./operator-site-admins.controller";
import { OperatorSiteAdminsService } from "./operator-site-admins.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, AuditModule],
  controllers: [OperatorSiteAdminsController],
  providers: [OperatorSiteAdminsService]
})
export class OperatorSiteAdminsModule {}
