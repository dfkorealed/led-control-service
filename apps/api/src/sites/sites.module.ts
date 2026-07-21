import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SitesController } from "./sites.controller";
import { SitesService } from "./sites.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [SitesController],
  providers: [SitesService],
  exports: [SitesService]
})
export class SitesModule {}
