import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RolesGuard } from "./roles.guard";
import { SiteAccessService } from "./site-access.service";

@Module({
  imports: [PrismaModule],
  providers: [RolesGuard, SiteAccessService],
  exports: [RolesGuard, SiteAccessService]
})
export class AccessModule {}
