import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import {
  ManufacturingAuthGuard,
  type ManufacturingCertificateRequest
} from "./manufacturing-auth.guard";
import { ManufacturingEnrollmentService } from "./manufacturing-enrollment.service";

interface CreateManufacturingEnrollmentBody {
  serialNumber: string;
}

interface EnrollManufacturingDeviceBody {
  serialNumber: string;
  token: string;
  csrPem: string;
}

@Controller()
export class ManufacturingEnrollmentController {
  constructor(private readonly service: ManufacturingEnrollmentService) {}

  @Post("manufacturing/gateway-enrollments")
  @UseGuards(ManufacturingAuthGuard)
  createEnrollment(
    @Body() body: CreateManufacturingEnrollmentBody,
    @Req() request: ManufacturingCertificateRequest
  ) {
    return this.service.createEnrollment({
      serialNumber: body.serialNumber,
      stationIdentity: request.manufacturingStationIdentity ?? ""
    });
  }

  @Post("gateway-manufacturing/enroll")
  enrollDevice(@Body() body: EnrollManufacturingDeviceBody) {
    return this.service.enrollDevice(body);
  }
}
