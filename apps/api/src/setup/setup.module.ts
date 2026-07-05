import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SitesModule } from "../sites/sites.module";
import { SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  imports: [PrismaModule, AuthModule, SitesModule],
  controllers: [SetupController],
  providers: [SetupService]
})
export class SetupModule {}
