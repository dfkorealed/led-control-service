import { Module } from "@nestjs/common";
import { AutomationOutboxPublisherService } from "../automation/automation-outbox-publisher.service";
import { AutomationRuntimeModule } from "../automation/automation-runtime.module";
import { MeshControlGroupModule } from "../mesh-control-groups/mesh-control-group.module";
import { MeshGroupSyncWorker } from "../mesh-control-groups/mesh-group-sync.worker";
import { PrismaModule } from "../prisma/prisma.module";
import { MqttService } from "./mqtt.service";
import { FixtureFreshnessService } from "../fixtures/fixture-freshness.service";
import { CommandTimeoutService } from "../commands/command-timeout.service";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { ProvisioningScanOutboxPublisherService } from "./provisioning-scan-outbox-publisher.service";
import { ProvisioningDeviceOutboxPublisherService } from "./provisioning-device-outbox-publisher.service";
import { MqttShutdownCoordinator } from "./mqtt-shutdown-coordinator.service";
import { FixtureStateIngestionService } from "../energy/fixture-state-ingestion.service";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { MonitoringIncidentsModule } from "../monitoring-incidents/monitoring-incidents.module";
import { ProvisioningDeviceTerminalService } from "./provisioning-device-terminal.service";
import { FixturePresenceIngestionService } from "../fixtures/fixture-presence-ingestion.service";
import { MonitoringRefreshIngestionService } from "../monitoring-refresh/monitoring-refresh-ingestion.service";

@Module({
  imports: [PrismaModule, MeshControlGroupModule, AutomationRuntimeModule, MonitoringIncidentsModule],
  providers: [
    MqttService,
    FixtureStateIngestionService,
    FixturePresenceIngestionService,
    MonitoringRefreshIngestionService,
    EnergyDimensionHistoryService,
    FixtureFreshnessService,
    OutboxPublisherService,
    AutomationOutboxPublisherService,
    ProvisioningScanOutboxPublisherService,
    ProvisioningDeviceOutboxPublisherService,
    ProvisioningDeviceTerminalService,
    MqttShutdownCoordinator,
    CommandTimeoutService,
    MeshGroupSyncWorker
  ],
  exports: [MqttService]
})
export class MqttModule {}
