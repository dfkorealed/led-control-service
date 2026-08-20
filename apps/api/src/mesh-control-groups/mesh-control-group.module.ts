import { Module } from "@nestjs/common";
import { MeshControlGroupService } from "./mesh-control-group.service";

@Module({
  providers: [MeshControlGroupService],
  exports: [MeshControlGroupService]
})
export class MeshControlGroupModule {}
