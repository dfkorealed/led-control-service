import { Body, Controller, Optional, Post, Req, UseGuards } from "@nestjs/common";
import { DeviceCertificateGuard, type DeviceCertificateRequest } from "../gateway-onboarding/device-certificate.guard";
import { CertificateLifecycleService } from "./certificate-lifecycle.service";
import { GatewayCertificateService } from "./gateway-certificate.service";

@Controller()
export class GatewayCertificateController {
  constructor(
    private readonly service: GatewayCertificateService,
    @Optional() private readonly lifecycle?: CertificateLifecycleService
  ) {}

  @Post("gateway-certificates/mqtt")
  @UseGuards(DeviceCertificateGuard)
  issueMqttCertificate(@Body() body: unknown, @Req() request: DeviceCertificateRequest) {
    return this.service.issueMqttCertificate({
      csrPem: body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { csrPem?: unknown }).csrPem : undefined,
      deviceCertificateFingerprint: request.deviceCertificateFingerprint ?? ""
    });
  }

  @Post("gateway-certificates/device/renew")
  @UseGuards(DeviceCertificateGuard)
  renewDeviceCertificate(@Body() body: unknown, @Req() request: DeviceCertificateRequest) {
    return this.lifecycle!.renewDeviceCertificate({
      csrPem: body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { csrPem?: unknown }).csrPem : undefined,
      deviceCertificateFingerprint: request.deviceCertificateFingerprint ?? ""
    });
  }

  @Post("gateway-certificates/device/activate")
  @UseGuards(DeviceCertificateGuard)
  activateDeviceCertificate(@Req() request: DeviceCertificateRequest) {
    return this.lifecycle!.activateDeviceCertificate({ deviceCertificateFingerprint: request.deviceCertificateFingerprint ?? "" });
  }
}
