import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { MeshControlGroupService } from "./mesh-control-group.service";

@Module({
  imports: [PrismaModule],
  providers: [MeshControlGroupService],
  exports: [MeshControlGroupService]
})
export class MeshControlGroupModule {}
