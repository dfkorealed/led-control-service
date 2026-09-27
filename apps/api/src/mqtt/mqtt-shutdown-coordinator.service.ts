import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import { MeshGroupSyncWorker } from "../mesh-control-groups/mesh-group-sync.worker";
import { AutomationOutboxPublisherService } from "../automation/automation-outbox-publisher.service";
import { MqttService } from "./mqtt.service";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { LegacyStatusCheckPublisherService } from "./legacy-status-check-publisher.service";
import { RecoveryOutboxPublisherService } from "./recovery-outbox-publisher.service";
import { ProvisioningScanOutboxPublisherService } from "./provisioning-scan-outbox-publisher.service";
import { ProvisioningDeviceOutboxPublisherService } from "./provisioning-device-outbox-publisher.service";

@Injectable()
export class MqttShutdownCoordinator implements OnModuleDestroy {
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly commandOutbox: OutboxPublisherService,
    private readonly legacyStatusCheckOutbox: LegacyStatusCheckPublisherService,
    private readonly scanOutbox: ProvisioningScanOutboxPublisherService,
    private readonly provisioningDeviceOutbox: ProvisioningDeviceOutboxPublisherService,
    private readonly automationOutbox: AutomationOutboxPublisherService,
    private readonly meshGroupSync: MeshGroupSyncWorker,
    private readonly mqtt: MqttService,
    @Optional() private readonly recoveryOutbox?: RecoveryOutboxPublisherService
  ) {}

  onModuleDestroy() {
    if (!this.shutdownPromise) {
      const commandDrain = this.commandOutbox.stopAndDrain();
      const legacyStatusCheckDrain = this.legacyStatusCheckOutbox.stopAndDrain();
      const scanDrain = this.scanOutbox.stopAndDrain();
      const provisioningDeviceDrain = this.provisioningDeviceOutbox.stopAndDrain();
      const automationDrain = this.automationOutbox.stopAndDrain();
      const meshGroupDrain = this.meshGroupSync.stopAndDrain();
      const inboundDrain = this.mqtt.stopInboundAndDrain();
      this.shutdownPromise = Promise.all([
        commandDrain,
        legacyStatusCheckDrain,
        this.recoveryOutbox?.stopAndDrain(),
        scanDrain,
        provisioningDeviceDrain,
        automationDrain,
        meshGroupDrain,
        inboundDrain
      ]).then(() => this.mqtt.close());
    }
    return this.shutdownPromise;
  }
}
