import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SiteUsersController } from "./site-users.controller";
import { SiteUsersService } from "./site-users.service";

@Module({
  imports: [PrismaModule, AccessModule, AuthModule, AuditModule],
  controllers: [SiteUsersController], providers: [SiteUsersService]
})
export class SiteUsersModule {}
