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

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, AuditModule, StorageModule, RedisModule],
  controllers: [FloorEditorController, FloorAssetsController],
  providers: [FloorEditorService, FloorAssetsService, EditorLeaseService]
})
export class FloorEditorModule {}
