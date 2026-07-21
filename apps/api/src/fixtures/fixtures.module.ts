import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FixturesController } from "./fixtures.controller";
import { FixturesService } from "./fixtures.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [FixturesController],
  providers: [FixturesService]
})
export class FixturesModule {}
