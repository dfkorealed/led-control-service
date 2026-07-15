import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { DeviceCertificateGuard, type DeviceCertificateRequest } from "../gateway-onboarding/device-certificate.guard";
import { GatewayCertificateService } from "./gateway-certificate.service";

interface IssueMqttCertificateBody {
  csrPem: string;
}

@Controller()
export class GatewayCertificateController {
  constructor(private readonly service: GatewayCertificateService) {}

  @Post("gateway-certificates/mqtt")
  @UseGuards(DeviceCertificateGuard)
  issueMqttCertificate(@Body() body: IssueMqttCertificateBody, @Req() request: DeviceCertificateRequest) {
    return this.service.issueMqttCertificate({
      csrPem: body.csrPem,
      deviceCertificateFingerprint: request.deviceCertificateFingerprint ?? ""
    });
  }
}
