import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { DeviceCertificateGuard, type DeviceCertificateRequest } from "../gateway-onboarding/device-certificate.guard";
import { GatewayCertificateService } from "./gateway-certificate.service";

@Controller()
export class GatewayCertificateController {
  constructor(private readonly service: GatewayCertificateService) {}

  @Post("gateway-certificates/mqtt")
  @UseGuards(DeviceCertificateGuard)
  issueMqttCertificate(@Body() body: unknown, @Req() request: DeviceCertificateRequest) {
    return this.service.issueMqttCertificate({
      csrPem: body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { csrPem?: unknown }).csrPem : undefined,
      deviceCertificateFingerprint: request.deviceCertificateFingerprint ?? ""
    });
  }
}
