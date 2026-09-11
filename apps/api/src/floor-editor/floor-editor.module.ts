import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FloorEditorController } from "./floor-editor.controller";
import { FloorEditorService } from "./floor-editor.service";
import { StorageModule } from "../storage/storage.module";
import { FloorAssetsController } from "./floor-assets.controller";
import { FloorAssetsService } from "./floor-assets.service";
import { AuditModule } from "../audit/audit.module";
import { RedisModule } from "../redis/redis.module";
import { EditorLeaseService } from "./editor-lease.service";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, AuditModule, StorageModule, RedisModule],
  controllers: [FloorEditorController, FloorAssetsController],
  providers: [FloorEditorService, FloorAssetsService, EditorLeaseService, FixtureEnergyCheckpointService, EnergyDimensionHistoryService]
})
export class FloorEditorModule {}
