import { Body, Controller, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { DeviceCertificateGuard, DeviceCertificateRequest } from "./device-certificate.guard";
import { GatewayOnboardingService } from "./gateway-onboarding.service";

interface ClaimGatewayBody {
  siteId: string;
  serialNumber: string;
  claimCode: string;
  name: string;
}

interface BootstrapGatewayBody {
  serialNumber: string;
}

interface ClaimRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

@Controller()
export class GatewayOnboardingController {
  constructor(private readonly service: GatewayOnboardingService) {}

  @Post("gateways/claim")
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles("operator")
  claimGateway(@CurrentUser() user: AuthenticatedUser, @Body() body: ClaimGatewayBody, @Req() request: ClaimRequest) {
    return this.service.claimGateway(user, { ...body, ipAddress: request.ip });
  }

  @Post("gateway-bootstrap")
  @UseGuards(DeviceCertificateGuard)
  bootstrapGateway(@Body() body: BootstrapGatewayBody, @Req() request: DeviceCertificateRequest) {
    return this.service.bootstrapGateway({
      serialNumber: body.serialNumber,
      certificateFingerprint: request.deviceCertificateFingerprint ?? ""
    });
  }

  @Post("gateway-inventories/:inventoryId/disable")
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles("operator")
  disableInventory(@CurrentUser() user: AuthenticatedUser, @Param("inventoryId") inventoryId: string) {
    return this.service.disableInventory(user, inventoryId);
  }
}
