import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { rootCertificates } from "node:tls";
import { GatewayOnboardingService } from "../src/gateway-onboarding/gateway-onboarding.service";
import { PrismaService } from "../src/prisma/prisma.service";
import type { CertificateAuthorityProvider } from "../src/pki/certificate-authority.provider";
import { GatewayCertificateService } from "../src/pki/gateway-certificate.service";
import { ManufacturingEnrollmentService } from "../src/pki/manufacturing-enrollment.service";

const DATABASE_URL = process.env.PKI_E2E_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;
const DEVICE_FINGERPRINT = "AA".repeat(32);
const MQTT_FINGERPRINT = "BB".repeat(32);
const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nE2E-CSR\n-----END CERTIFICATE REQUEST-----";

describeWithDatabase("gateway PKI PostgreSQL E2E", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.gatewayClaimAudit.deleteMany();
    await prisma.gatewayCertificate.deleteMany();
    await prisma.gatewayEnrollment.deleteMany();
    await prisma.gatewayInventory.deleteMany();
    await prisma.gateway.deleteMany();
    await prisma.site.deleteMany();
    await prisma.user.deleteMany();
    await prisma.organization.deleteMany();
  });

  it("connects manufacturing, one-time claim, bootstrap and MQTT issuance without manual DB edits", async () => {
    const { manufacturing, onboarding, mqtt } = services(prisma);
    const enrollment = await manufacturing.createEnrollment({ serialNumber: "GW-E2E-001", stationIdentity: "CN=station-e2e" });
    const issued = await manufacturing.enrollDevice({ serialNumber: "GW-E2E-001", token: enrollment.enrollmentToken, csrPem: CSR });

    await expect(manufacturing.enrollDevice({ serialNumber: "GW-E2E-001", token: enrollment.enrollmentToken, csrPem: CSR }))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const organization = await prisma.organization.create({ data: { name: "E2E organization" } });
    const user = await prisma.user.create({ data: {
      organizationId: organization.id, email: "pki-e2e@example.com", name: "E2E admin",
      passwordHash: "not-used", role: "admin"
    } });
    const site = await prisma.site.create({ data: {
      organizationId: organization.id, name: "E2E site", address: "E2E", tariffKwhRate: 100
    } });
    const claimed = await onboarding.claimGateway(
      { id: user.id, organizationId: organization.id, role: "admin" },
      { siteId: site.id, serialNumber: "GW-E2E-001", claimCode: issued.claimCode, name: "E2E gateway" }
    );

    await expect(onboarding.bootstrapGateway({ serialNumber: "GW-E2E-001", certificateFingerprint: "CC".repeat(32) }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(onboarding.bootstrapGateway({ serialNumber: "GW-E2E-001", certificateFingerprint: DEVICE_FINGERPRINT }))
      .resolves.toMatchObject({ status: "assigned", assignment: { gatewayId: claimed.gatewayId, siteId: site.id } });
    await expect(mqtt.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT }))
      .resolves.toMatchObject({ gatewayId: claimed.gatewayId });

    const ledger = await prisma.gatewayCertificate.findMany({ orderBy: { purpose: "asc" } });
    expect(ledger.map(({ purpose, fingerprint, status }) => ({ purpose, fingerprint, status }))).toEqual([
      { purpose: "device", fingerprint: DEVICE_FINGERPRINT, status: "active" },
      { purpose: "mqtt", fingerprint: MQTT_FINGERPRINT, status: "active" }
    ]);
  });

  it("terminally rejects serial mismatch and CSR tampering, then blocks disabled or revoked identities", async () => {
    const validator = { validate: jest.fn().mockResolvedValue({ publicKey: {} }) };
    const { manufacturing, mqtt } = services(prisma, validator);
    const mismatch = await manufacturing.createEnrollment({ serialNumber: "GW-E2E-002", stationIdentity: "CN=station-e2e" });
    await expect(manufacturing.enrollDevice({ serialNumber: "GW-E2E-OTHER", token: mismatch.enrollmentToken, csrPem: CSR }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(manufacturing.enrollDevice({ serialNumber: "GW-E2E-002", token: mismatch.enrollmentToken, csrPem: CSR }))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const tampered = await manufacturing.createEnrollment({ serialNumber: "GW-E2E-003", stationIdentity: "CN=station-e2e" });
    validator.validate.mockRejectedValueOnce(new BadRequestException("CSR is invalid"));
    await expect(manufacturing.enrollDevice({ serialNumber: "GW-E2E-003", token: tampered.enrollmentToken, csrPem: "tampered" }))
      .rejects.toBeInstanceOf(BadRequestException);

    const active = await manufacturing.createEnrollment({ serialNumber: "GW-E2E-004", stationIdentity: "CN=station-e2e" });
    await manufacturing.enrollDevice({ serialNumber: "GW-E2E-004", token: active.enrollmentToken, csrPem: CSR });
    await prisma.gatewayInventory.update({ where: { serialNumber: "GW-E2E-004" }, data: { disabledAt: new Date() } });
    await expect(mqtt.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await prisma.gatewayInventory.update({ where: { serialNumber: "GW-E2E-004" }, data: { disabledAt: null } });
    await prisma.gatewayCertificate.update({ where: { fingerprint: DEVICE_FINGERPRINT }, data: { status: "revoked", revokedAt: new Date() } });
    await expect(mqtt.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT }))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function services(prisma: PrismaService, validator = { validate: jest.fn().mockResolvedValue({ publicKey: {} }) }) {
  let mqttSerial = 1;
  const certificateAuthority: CertificateAuthorityProvider = {
    signCsr: jest.fn(async ({ purpose }) => ({
      certificatePem: rootCertificates[0],
      caChainPem: [rootCertificates[0]],
      certificateSerial: purpose === "device" ? "E2E01" : `E2E${++mqttSerial}`,
      fingerprint: purpose === "device" ? DEVICE_FINGERPRINT : MQTT_FINGERPRINT,
      issuer: `CN=E2E ${purpose} CA`,
      notBefore: new Date(Date.now() - 60_000).toISOString(),
      notAfter: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    })),
    revoke: jest.fn(),
    readCrl: jest.fn()
  };
  return {
    manufacturing: new ManufacturingEnrollmentService(prisma, certificateAuthority, validator as never, {
      apiCaBundlePem: rootCertificates[0], mqttCaBundlePem: rootCertificates[0], manufacturingCaFingerprint: "CC".repeat(32)
    }),
    onboarding: new GatewayOnboardingService(prisma),
    mqtt: new GatewayCertificateService(prisma, certificateAuthority, validator as never)
  };
}
