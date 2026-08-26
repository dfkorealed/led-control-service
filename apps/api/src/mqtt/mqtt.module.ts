import { Module } from "@nestjs/common";
import { MeshControlGroupModule } from "../mesh-control-groups/mesh-control-group.module";
import { MeshGroupSyncWorker } from "../mesh-control-groups/mesh-group-sync.worker";
import { PrismaModule } from "../prisma/prisma.module";
import { MqttService } from "./mqtt.service";
import { FixtureFreshnessService } from "../fixtures/fixture-freshness.service";
import { CommandTimeoutService } from "../commands/command-timeout.service";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { ProvisioningScanOutboxPublisherService } from "./provisioning-scan-outbox-publisher.service";

@Module({
  imports: [PrismaModule, MeshControlGroupModule],
  providers: [MqttService, FixtureFreshnessService, OutboxPublisherService, ProvisioningScanOutboxPublisherService, CommandTimeoutService, MeshGroupSyncWorker],
  exports: [MqttService]
})
export class MqttModule {}
