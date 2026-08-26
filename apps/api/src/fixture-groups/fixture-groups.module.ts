import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { MeshControlGroupModule } from "../mesh-control-groups/mesh-control-group.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FixtureGroupsController } from "./fixture-groups.controller";
import { FixtureGroupsService } from "./fixture-groups.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, MeshControlGroupModule],
  controllers: [FixtureGroupsController],
  providers: [FixtureGroupsService]
})
export class FixtureGroupsModule {}
