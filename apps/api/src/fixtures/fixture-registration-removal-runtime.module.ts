import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AccessModule } from "../access/access.module";
import { AutomationRuntimeModule } from "../automation/automation-runtime.module";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";
import { COMMAND_DB_CLOCK_EVIDENCE_SOURCE, CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";
import { createConfiguredCommandDbClockEvidenceSource } from "../mqtt/command-db-clock-evidence-source";
import { FixtureRegistrationRemovalCleanupService } from "./fixture-registration-removal-cleanup.service";
import { FixtureRegistrationRemovalsService } from "./fixture-registration-removals.service";
import { FixtureRegistrationRetirementService } from "./fixture-registration-retirement.service";

// HTTP and MQTT share durable operations without importing either transport.
@Module({ imports: [PrismaModule, AccessModule, AutomationRuntimeModule], providers: [
  FixtureRegistrationRemovalsService, FixtureRegistrationRemovalCleanupService, FixtureRegistrationRetirementService,
  FixtureEnergyCheckpointService, EnergyDimensionHistoryService, CommandDbClockHealth,
  { provide: COMMAND_DB_CLOCK_EVIDENCE_SOURCE, useFactory: () => createConfiguredCommandDbClockEvidenceSource(process.env) }
], exports: [FixtureRegistrationRemovalsService, FixtureRegistrationRemovalCleanupService] })
export class FixtureRegistrationRemovalRuntimeModule {}
