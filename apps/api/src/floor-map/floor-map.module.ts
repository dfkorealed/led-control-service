import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FloorMapController } from "./floor-map.controller";
import { FloorMapService } from "./floor-map.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule],
  controllers: [FloorMapController],
  providers: [FloorMapService]
})
export class FloorMapModule {}
