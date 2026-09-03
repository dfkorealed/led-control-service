import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PkiModule } from "../pki/pki.module";
import { StorageModule } from "../storage/storage.module";
import { OperatorSiteAdminsController } from "./operator-site-admins.controller";
import { OperatorSiteAdminsService } from "./operator-site-admins.service";
import { SiteDeletionCleanupService } from "./site-deletion-cleanup.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, AuditModule, PkiModule, StorageModule],
  controllers: [OperatorSiteAdminsController],
  providers: [OperatorSiteAdminsService, SiteDeletionCleanupService]
})
export class OperatorSiteAdminsModule {}
