import { BadRequestException } from "@nestjs/common";
import { GatewayCertificateController } from "./gateway-certificate.controller";

describe("GatewayCertificateController", () => {
  it.each([undefined, null, {}, []])("passes an invalid MQTT certificate body (%p) to service validation without a TypeError", async (body) => {
    const service = {
      issueMqttCertificate: jest.fn().mockRejectedValue(new BadRequestException("CSR is invalid"))
    };
    const controller = new GatewayCertificateController(service as never);

    await expect(
      controller.issueMqttCertificate(body as never, { deviceCertificateFingerprint: "AA".repeat(32) } as never)
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(service.issueMqttCertificate).toHaveBeenCalledWith({
      csrPem: undefined,
      deviceCertificateFingerprint: "AA".repeat(32)
    });
  });

  it("passes only the mTLS fingerprint to device renewal and activation", async () => {
    const service = {
      renewDeviceCertificate: jest.fn().mockResolvedValue({}),
      activateDeviceCertificate: jest.fn().mockResolvedValue({ status: "active" })
    };
    const controller = new GatewayCertificateController({} as never, service as never);
    const request = { deviceCertificateFingerprint: "AA".repeat(32) } as never;

    await controller.renewDeviceCertificate({ csrPem: "CSR", certificateFingerprint: "untrusted" } as never, request);
    await controller.activateDeviceCertificate(request);

    expect(service.renewDeviceCertificate).toHaveBeenCalledWith({ csrPem: "CSR", deviceCertificateFingerprint: "AA".repeat(32) });
    expect(service.activateDeviceCertificate).toHaveBeenCalledWith({ deviceCertificateFingerprint: "AA".repeat(32) });
  });
});
