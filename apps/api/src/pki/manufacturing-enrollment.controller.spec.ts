import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ManufacturingAuthGuard } from "./manufacturing-auth.guard";
import { ManufacturingEnrollmentController } from "./manufacturing-enrollment.controller";

describe("ManufacturingEnrollmentController", () => {
  it("uses only the manufacturing station identity attached by the mTLS guard", async () => {
    const service = { createEnrollment: jest.fn().mockResolvedValue({ enrollmentToken: "once" }) };
    const controller = new ManufacturingEnrollmentController(service as never);

    await controller.createEnrollment(
      { serialNumber: "GW-001", stationIdentity: "untrusted-body" } as never,
      {
        headers: { "x-manufacturing-station": "untrusted-header" },
        manufacturingStationIdentity: "CN=station-01"
      } as never
    );

    expect(service.createEnrollment).toHaveBeenCalledWith({
      serialNumber: "GW-001",
      stationIdentity: "CN=station-01"
    });
  });

  it("passes token, serial, and CSR to the unauthenticated manufacturing device endpoint", async () => {
    const response = {
      deviceCertificatePem: "certificate",
      deviceCaBundlePem: "device CA",
      apiCaBundlePem: "API CA",
      mqttCaBundlePem: "MQTT CA",
      claimCode: "once"
    };
    const service = { enrollDevice: jest.fn().mockResolvedValue(response) };
    const controller = new ManufacturingEnrollmentController(service as never);
    const body = { serialNumber: "GW-001", token: "once", csrPem: "CSR" };

    await expect(controller.enrollDevice(body)).resolves.toEqual(response);

    expect(service.enrollDevice).toHaveBeenCalledWith(body);
  });

  it("applies the manufacturing guard only to station enrollment creation", () => {
    const createGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      ManufacturingEnrollmentController.prototype.createEnrollment
    ) as unknown[];
    const deviceGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      ManufacturingEnrollmentController.prototype.enrollDevice
    ) as unknown[] | undefined;

    expect(createGuards).toContain(ManufacturingAuthGuard);
    expect(deviceGuards).toBeUndefined();
  });
});
