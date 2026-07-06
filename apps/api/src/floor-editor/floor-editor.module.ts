import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FloorEditorController } from "./floor-editor.controller";
import { FloorEditorService } from "./floor-editor.service";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FloorEditorController],
  providers: [FloorEditorService]
})
export class FloorEditorModule {}
