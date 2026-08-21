import { Module } from "@nestjs/common";
import { MqttModule } from "../mqtt/mqtt.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MeshControlGroupService } from "./mesh-control-group.service";
import { MeshGroupSyncWorker } from "./mesh-group-sync.worker";

@Module({
  imports: [PrismaModule, MqttModule],
  providers: [MeshControlGroupService, MeshGroupSyncWorker],
  exports: [MeshControlGroupService]
})
export class MeshControlGroupModule {}
