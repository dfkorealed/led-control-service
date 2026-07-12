import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FloorAssetsService } from "./floor-assets.service";

@Controller("floors/:floorId/assets")
@UseGuards(SessionAuthGuard)
export class FloorAssetsController {
  constructor(private readonly floorAssetsService: FloorAssetsService) {}

  @Post("upload-intent")
  createUploadIntent(
    @Param("floorId") floorId: string,
    @Body() body: { kind: "original" | "rendered"; mimeType: string; sizeBytes: number; sha256: string },
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorAssetsService.createUploadIntent(floorId, user.organizationId, body);
  }

  @Post(":assetId/complete")
  completeUpload(
    @Param("floorId") floorId: string,
    @Param("assetId") assetId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorAssetsService.completeUpload(floorId, assetId, user.organizationId);
  }
}
