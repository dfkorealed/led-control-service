import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { MqttService } from "./mqtt.service";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { ProvisioningScanOutboxPublisherService } from "./provisioning-scan-outbox-publisher.service";

@Injectable()
export class MqttShutdownCoordinator implements OnModuleDestroy {
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly commandOutbox: OutboxPublisherService,
    private readonly scanOutbox: ProvisioningScanOutboxPublisherService,
    private readonly mqtt: MqttService
  ) {}

  onModuleDestroy() {
    if (!this.shutdownPromise) {
      const commandDrain = this.commandOutbox.stopAndDrain();
      const scanDrain = this.scanOutbox.stopAndDrain();
      this.shutdownPromise = Promise.all([commandDrain, scanDrain]).then(() => this.mqtt.close());
    }
    return this.shutdownPromise;
  }
}
