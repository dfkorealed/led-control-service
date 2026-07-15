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
});
