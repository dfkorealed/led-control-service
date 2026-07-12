import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FloorEditorController } from "./floor-editor.controller";
import { FloorEditorService } from "./floor-editor.service";
import { StorageModule } from "../storage/storage.module";
import { FloorAssetsController } from "./floor-assets.controller";
import { FloorAssetsService } from "./floor-assets.service";

@Module({
  imports: [PrismaModule, AuthModule, StorageModule],
  controllers: [FloorEditorController, FloorAssetsController],
  providers: [FloorEditorService, FloorAssetsService]
})
export class FloorEditorModule {}
