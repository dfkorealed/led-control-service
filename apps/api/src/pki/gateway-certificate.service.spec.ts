import { BadRequestException, ConflictException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { CertificateAuthorityProvider } from "./certificate-authority.provider";
import { GatewayCertificateService } from "./gateway-certificate.service";

const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nSECRET-MQTT-CSR\n-----END CERTIFICATE REQUEST-----";
const DEVICE_FINGERPRINT = "AA".repeat(32);
const MQTT_FINGERPRINT = "BB".repeat(32);
const NOW = new Date("2026-07-15T03:00:00.000Z");

describe("GatewayCertificateService", () => {
  it("rejects a device whose inventory has not been claimed", async () => {
    const { service, ca, csrValidator } = createFixture({ inventory: { claimedGatewayId: null, claimedGateway: null } });

    await expect(service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })).rejects.toThrow(
      ConflictException
    );

    expect(csrValidator.validate).not.toHaveBeenCalled();
    expect(ca.signCsr).not.toHaveBeenCalled();
  });

  it.each([
    ["does not match the inventory device pointer", { inventory: { certificateFingerprint: MQTT_FINGERPRINT } }],
    ["is not active", { deviceCertificate: { status: "revoked" as const } }]
  ])("rejects a device certificate that %s", async (_case, patch) => {
    const { service, ca, csrValidator } = createFixture(patch);

    await expect(service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })).rejects.toThrow(
      UnauthorizedException
    );

    expect(csrValidator.validate).not.toHaveBeenCalled();
    expect(ca.signCsr).not.toHaveBeenCalled();
  });

  it("rejects a claimed inventory that has no gateway assignment", async () => {
    const { service, ca, csrValidator } = createFixture({ inventory: { claimedGateway: null } });

    await expect(service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })).rejects.toThrow(
      ConflictException
    );

    expect(csrValidator.validate).not.toHaveBeenCalled();
    expect(ca.signCsr).not.toHaveBeenCalled();
  });

  it("rejects an invalid MQTT CSR before signing", async () => {
    const { service, ca, csrValidator } = createFixture();
    csrValidator.validate.mockRejectedValue(new BadRequestException("CSR proof-of-possession is invalid"));

    await expect(service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })).rejects.toThrow(
      "CSR proof-of-possession is invalid"
    );

    expect(ca.signCsr).not.toHaveBeenCalled();
  });

  it("issues a 90-day MQTT certificate for the assigned gateway and replaces the prior active MQTT certificate", async () => {
    const { service, prisma, ca } = createFixture({
      activeMqttCertificate: {
        id: "mqtt-certificate-old",
        inventoryId: "inventory-1",
        purpose: "mqtt",
        status: "active",
        replacedById: null
      }
    });

    const result = await service.issueMqttCertificate({
      csrPem: CSR,
      deviceCertificateFingerprint: DEVICE_FINGERPRINT.match(/.{2}/g)?.join(":").toLowerCase() ?? DEVICE_FINGERPRINT
    });

    expect(ca.signCsr).toHaveBeenCalledWith({
      purpose: "mqtt",
      csrPem: CSR,
      commonName: "gateway-1",
      uriSans: ["urn:dfkorea:gateway:gateway-1"],
      ttlSeconds: 90 * 24 * 60 * 60
    });
    expect(prisma.gatewayCertificate.create).toHaveBeenCalledWith({
      data: {
        inventoryId: "inventory-1",
        gatewayId: "gateway-1",
        purpose: "mqtt",
        certificateSerial: "0102",
        fingerprint: MQTT_FINGERPRINT,
        issuer: "CN=MQTT Issuing CA",
        notBefore: new Date("2026-07-15T00:00:00.000Z"),
        notAfter: new Date("2026-10-13T00:00:00.000Z"),
        status: "active"
      }
    });
    expect(prisma.gatewayCertificate.update).toHaveBeenCalledWith({
      where: { id: "mqtt-certificate-old" },
      data: { status: "replaced", replacedById: "mqtt-certificate-new" }
    });
    expect(prisma.gatewayInventory.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      gatewayId: "gateway-1",
      certificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-MQTT-CERT\n-----END CERTIFICATE-----",
      caChainPem: ["MQTT PUBLIC CA"],
      notAfter: "2026-10-13T00:00:00.000Z"
    });
  });

  it("best-effort revokes the new MQTT certificate when its ledger transaction fails", async () => {
    const { service, prisma, ca } = createFixture();
    prisma.$transaction.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })).rejects.toThrow(
      ServiceUnavailableException
    );

    expect(ca.revoke).toHaveBeenCalledWith({
      purpose: "mqtt",
      certificateSerial: "01:02",
      issuer: "CN=MQTT Issuing CA",
      fingerprint: MQTT_FINGERPRINT.match(/.{2}/g)?.join(":")
    });
  });
});

function createFixture(overrides: {
  inventory?: Partial<TestInventory>;
  deviceCertificate?: Partial<TestDeviceCertificate>;
  activeMqttCertificate?: Record<string, unknown> | null;
} = {}) {
  const inventory: TestInventory = { ...baseInventory(), ...overrides.inventory };
  if (overrides.inventory?.claimedGateway === null) inventory.claimedGateway = null;
  const deviceCertificate: TestDeviceCertificate = { ...baseDeviceCertificate(), ...overrides.deviceCertificate, inventory };
  const prisma: any = {
    gatewayCertificate: {
      findUnique: jest.fn().mockResolvedValue(deviceCertificate),
      findFirst: jest.fn().mockResolvedValue(overrides.activeMqttCertificate ?? null),
      create: jest.fn().mockResolvedValue({ id: "mqtt-certificate-new" }),
      update: jest.fn().mockResolvedValue(undefined)
    },
    gatewayInventory: { update: jest.fn() }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));

  const ca = {
    signCsr: jest.fn().mockResolvedValue({
      certificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-MQTT-CERT\n-----END CERTIFICATE-----",
      caChainPem: ["MQTT PUBLIC CA"],
      certificateSerial: "01:02",
      fingerprint: MQTT_FINGERPRINT.match(/.{2}/g)?.join(":"),
      issuer: "CN=MQTT Issuing CA",
      notBefore: "2026-07-15T00:00:00.000Z",
      notAfter: "2026-10-13T00:00:00.000Z"
    }),
    revoke: jest.fn().mockResolvedValue(undefined)
  } as jest.Mocked<CertificateAuthorityProvider>;
  const csrValidator = { validate: jest.fn().mockResolvedValue({ publicKey: {} as CryptoKey }) };
  return {
    service: new GatewayCertificateService(prisma, ca, csrValidator),
    prisma,
    ca,
    csrValidator
  };
}

function baseInventory(): TestInventory {
  return {
    id: "inventory-1",
    certificateFingerprint: DEVICE_FINGERPRINT,
    claimedGatewayId: "gateway-1",
    disabledAt: null,
    claimedGateway: { id: "gateway-1" }
  };
}

function baseDeviceCertificate(): TestDeviceCertificate {
  return {
    id: "device-certificate-1",
    inventoryId: "inventory-1",
    purpose: "device",
    status: "active",
    fingerprint: DEVICE_FINGERPRINT,
    inventory: baseInventory()
  };
}

interface TestInventory {
  id: string;
  certificateFingerprint: string | null;
  claimedGatewayId: string | null;
  disabledAt: Date | null;
  claimedGateway: { id: string } | null;
}

interface TestDeviceCertificate {
  id: string;
  inventoryId: string;
  purpose: "device" | "mqtt";
  status: "active" | "replaced" | "revoked" | "expired";
  fingerprint: string;
  inventory: TestInventory;
}
