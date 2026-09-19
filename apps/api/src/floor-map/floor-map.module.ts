import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { CadSceneEvidenceService } from "./cad-scene-evidence.service";
import { FloorMapController } from "./floor-map.controller";
import { FloorMapService } from "./floor-map.service";
import { FloorEditorModule } from "../floor-editor/floor-editor.module";

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, AuditModule, StorageModule, FloorEditorModule],
  controllers: [FloorMapController],
  providers: [FloorMapService, CadSceneEvidenceService]
})
export class FloorMapModule {}
