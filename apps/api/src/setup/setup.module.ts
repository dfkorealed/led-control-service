import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SitesModule } from "../sites/sites.module";
import { SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, SitesModule],
  controllers: [SetupController],
  providers: [SetupService]
})
export class SetupModule {}
