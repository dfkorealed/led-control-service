import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AccessModule } from "../access/access.module";
import { BioSensorProfilesService } from "./bio-sensor-profiles.service";
import { BioSensorPreparationService } from "./bio-sensor-preparation.service";
import { AutomationClock } from "./automation-clock";
import { AutomationMqttConsumerService } from "./automation-mqtt-consumer.service";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";

@Module({
  imports: [PrismaModule, AccessModule],
  providers: [
    BioSensorProfilesService,
    BioSensorPreparationService,
    AutomationClock,
    AutomationMqttConsumerService,
    AutomationSnapshotService,
    VehicleSensorCapabilityService
  ],
  exports: [
    BioSensorProfilesService,
    BioSensorPreparationService,
    AutomationClock,
    AutomationMqttConsumerService,
    AutomationSnapshotService,
    VehicleSensorCapabilityService
  ]
})
export class AutomationRuntimeModule {}
