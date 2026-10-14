import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AccessModule } from "../access/access.module";
import { BioSensorProfilesService } from "./bio-sensor-profiles.service";
import { BioSensorPreparationService } from "./bio-sensor-preparation.service";
import { AutomationClock } from "./automation-clock";
import { AutomationMqttConsumerService } from "./automation-mqtt-consumer.service";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";
import { AuditModule } from "../audit/audit.module";
import { BioClassificationReconciliationService } from "../registration/bio-classification-reconciliation.service";
import { HOLIDAY_DATASET_PROMOTION, HolidayDatasetService } from "./holiday-dataset.service";

@Module({
  imports: [PrismaModule, AccessModule, AuditModule],
  providers: [
    BioClassificationReconciliationService,
    BioSensorProfilesService,
    BioSensorPreparationService,
    AutomationClock,
    HolidayDatasetService,
    AutomationMqttConsumerService,
    AutomationSnapshotService,
    { provide: HOLIDAY_DATASET_PROMOTION, useExisting: AutomationSnapshotService },
    VehicleSensorCapabilityService
  ],
  exports: [
    BioSensorProfilesService,
    BioSensorPreparationService,
    AutomationClock,
    HolidayDatasetService,
    AutomationMqttConsumerService,
    AutomationSnapshotService,
    VehicleSensorCapabilityService
  ]
})
export class AutomationRuntimeModule {}
