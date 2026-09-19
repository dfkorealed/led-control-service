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
import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentAssetReferences } from "./map-document-asset-references";
import { MapDocumentResetService } from "./map-document-reset.service";
import { MapDocumentMutationService } from "./map-document-mutation.service";
import { MapDocumentRevisionData } from "./map-document-revision-data";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, AuditModule, StorageModule, RedisModule],
  controllers: [FloorEditorController, FloorAssetsController],
  providers: [
    FloorEditorService,
    FloorAssetsService,
    FloorAssetCleanupService,
    MapDocumentStore,
    MapDocumentAssetReferences,
    MapDocumentResetService,
    MapDocumentMutationService,
    MapDocumentRevisionData,
    EditorLeaseService,
    FixtureEnergyCheckpointService,
    EnergyDimensionHistoryService
  ],
  exports: [MapDocumentStore, MapDocumentRevisionData]
})
export class FloorEditorModule {}
