import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { FloorEditorModule } from "./floor-editor.module";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { MAP_QUERY_REVISION_READER, MapDocumentReader } from "./map-document-reader";
import { MapDocumentQueryController } from "./map-document-query.controller";

/** Importing FloorEditorModule here (not vice versa) avoids the editor/import
 * module cycle and reuses the same revision reader as normal saves. */
@Module({
  imports: [PrismaModule, AuthModule, AccessModule, StorageModule, FloorEditorModule],
  controllers: [MapDocumentQueryController],
  providers: [MapDocumentReader, { provide: MAP_QUERY_REVISION_READER, useExisting: MapDocumentRevisionData }],
  exports: [MapDocumentReader]
})
export class MapDocumentQueryModule {}
