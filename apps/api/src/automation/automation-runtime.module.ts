import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AutomationClock } from "./automation-clock";
import { AutomationMqttConsumerService } from "./automation-mqtt-consumer.service";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";

@Module({
  imports: [PrismaModule],
  providers: [
    AutomationClock,
    AutomationMqttConsumerService,
    AutomationSnapshotService,
    VehicleSensorCapabilityService
  ],
  exports: [
    AutomationClock,
    AutomationMqttConsumerService,
    AutomationSnapshotService,
    VehicleSensorCapabilityService
  ]
})
export class AutomationRuntimeModule {}
