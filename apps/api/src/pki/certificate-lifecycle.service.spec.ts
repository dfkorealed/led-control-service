import {
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import type { CertificateAuthorityProvider } from "./certificate-authority.provider";
import { CertificateLifecycleService } from "./certificate-lifecycle.service";
import { reconciliationFixture } from "./reconciliation.test-support";

const ACTIVE_FINGERPRINT = "AA".repeat(32);
const PENDING_FINGERPRINT = "BB".repeat(32);
const NOW = new Date("2026-07-15T03:00:00.000Z");
const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nSECRET-DEVICE-CSR\n-----END CERTIFICATE REQUEST-----";

describe("CertificateLifecycleService", () => {
  it("does not expose a provider exception body even when the provider uses an HTTP exception", async () => {
    const { service, certificateAuthority } = createFixture();
    certificateAuthority.signCsr.mockRejectedValueOnce(new UnauthorizedException("provider-secret CSR PEM"));
    const error = await service.renewDeviceCertificate({ csrPem: CSR, deviceCertificateFingerprint: ACTIVE_FINGERPRINT }).catch(value => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String(error)).not.toContain("provider-secret");
  });
  it("locks activation before accepting an already-active stale preflight", async () => {
    const { service, prisma } = createFixture({ activationStatus: "active" });
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    await service.activateDeviceCertificate({ deviceCertificateFingerprint: PENDING_FINGERPRINT });
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });
  it("rejects activation when the pending certificate carries a revocation timestamp", async () => {
    const { service, prisma } = createFixture();
    const pending = await prisma.gatewayCertificate.findUnique({ where: { id: "device-pending" } });
    pending.revokedAt = NOW;
    await expect(service.activateDeviceCertificate({ deviceCertificateFingerprint: PENDING_FINGERPRINT })).rejects.toThrow(UnauthorizedException);
    expect(prisma.gatewayCertificate.update).not.toHaveBeenCalled();
  });
  it("rejects a pending certificate issued for a different Gateway assignment", async () => {
    const { service, prisma } = createFixture();
    const pending = await prisma.gatewayCertificate.findUnique({ where: { id: "device-pending" } });
    pending.gatewayId = "another-gateway";
    await expect(service.activateDeviceCertificate({ deviceCertificateFingerprint: PENDING_FINGERPRINT })).rejects.toThrow(UnauthorizedException);
    expect(prisma.gatewayCertificate.update).not.toHaveBeenCalled();
  });
  it.each(["disabledAt", "status", "pointer", "assignment", "revokedAt"])("rejects post-sign renewal %s drift", async (drift) => {
    const { service, prisma, certificateAuthority } = createFixture();
    const signed = await certificateAuthority.signCsr({} as never);
    certificateAuthority.signCsr.mockClear();
    certificateAuthority.signCsr.mockImplementationOnce(async () => {
      const current = await prisma.gatewayCertificate.findUnique({ where: { id: "device-active" } });
      if (drift === "disabledAt") current.inventory.disabledAt = NOW;
      if (drift === "status") current.status = "revocation_pending";
      if (drift === "pointer") current.inventory.certificateFingerprint = PENDING_FINGERPRINT;
      if (drift === "assignment") current.inventory.claimedGatewayId = "different-gateway";
      if (drift === "revokedAt") current.revokedAt = NOW;
      return signed;
    });
    await expect(service.renewDeviceCertificate({ csrPem: CSR, deviceCertificateFingerprint: ACTIVE_FINGERPRINT })).rejects.toThrow();
    expect(prisma.gatewayCertificate.create).not.toHaveBeenCalled();
  });
  it("signs a P-256 CSR inside the 30-day renewal window but preserves the active pointer", async () => {
    const { service, prisma, certificateAuthority } = createFixture({ notAfter: daysFromNow(30) });

    const result = await service.renewDeviceCertificate({ csrPem: CSR, deviceCertificateFingerprint: ACTIVE_FINGERPRINT });

    expect(certificateAuthority.signCsr).toHaveBeenCalledWith({
      purpose: "device",
      csrPem: CSR,
      commonName: "GW-PROD-001",
      uriSans: ["urn:dfkorea:gateway:GW-PROD-001"],
      ttlSeconds: 365 * 24 * 60 * 60
    });
    expect(prisma.gatewayCertificate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inventoryId: "inventory-1",
        gatewayId: "gateway-1",
        purpose: "device",
        fingerprint: PENDING_FINGERPRINT,
        status: "pending"
      })
    });
    expect(prisma.gatewayInventory.update).not.toHaveBeenCalled();
    expect(prisma.gateway.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      gatewayId: "gateway-1",
      certificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-DEVICE-CERT\n-----END CERTIFICATE-----",
      caChainPem: ["DEVICE CA"]
    });
  });

  it("rejects a second pending device certificate for the same inventory before signing", async () => {
    const { service, prisma, certificateAuthority } = createFixture();
    prisma.gatewayCertificate.findFirst.mockResolvedValueOnce({ id: "already-pending", status: "pending" });

    await expect(service.renewDeviceCertificate({ csrPem: CSR, deviceCertificateFingerprint: ACTIVE_FINGERPRINT })).rejects.toThrow(
      ConflictException
    );

    expect(certificateAuthority.signCsr).not.toHaveBeenCalled();
  });

  it("revokes a signed certificate and returns 503 when CA fingerprint metadata is invalid", async () => {
    const { service, certificateAuthority } = createFixture();
    certificateAuthority.signCsr.mockResolvedValueOnce({
      certificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-DEVICE-CERT\n-----END CERTIFICATE-----",
      caChainPem: ["DEVICE CA"],
      certificateSerial: "02:03",
      fingerprint: "not-a-fingerprint",
      issuer: "CN=Device Issuing CA",
      notBefore: NOW.toISOString(),
      notAfter: daysFromNow(365).toISOString()
    });

    await expect(service.renewDeviceCertificate({ csrPem: CSR, deviceCertificateFingerprint: ACTIVE_FINGERPRINT })).rejects.toThrow(
      ServiceUnavailableException
    );

    expect(certificateAuthority.revoke).toHaveBeenCalledWith({
      purpose: "device",
      certificateSerial: "02:03",
      issuer: "CN=Device Issuing CA",
      fingerprint: "not-a-fingerprint"
    });
  });

  it("rejects renewal before the 30-day window", async () => {
    const notAfter = daysFromNow(30, 1);
    const { service, certificateAuthority } = createFixture({ notAfter });

    await expect(service.renewDeviceCertificate({ csrPem: CSR, deviceCertificateFingerprint: ACTIVE_FINGERPRINT })).rejects.toThrow(
      ConflictException
    );

    expect(certificateAuthority.signCsr).not.toHaveBeenCalled();
  });

  it("fails closed when the active device certificate is expired", async () => {
    const { service, certificateAuthority } = createFixture({ notAfter: daysFromNow(-1) });

    await expect(service.renewDeviceCertificate({ csrPem: CSR, deviceCertificateFingerprint: ACTIVE_FINGERPRINT })).rejects.toThrow(
      UnauthorizedException
    );

    expect(certificateAuthority.signCsr).not.toHaveBeenCalled();
  });

  it("activates a pending device certificate atomically and updates both active pointers", async () => {
    const { service, prisma } = createFixture({ activationFingerprint: PENDING_FINGERPRINT });

    await service.activateDeviceCertificate({ deviceCertificateFingerprint: PENDING_FINGERPRINT });

    expect(prisma.gatewayCertificate.update).toHaveBeenNthCalledWith(1, {
      where: { id: "device-active" },
      data: { status: "replaced", replacedById: "device-pending" }
    });
    expect(prisma.gatewayCertificate.update).toHaveBeenNthCalledWith(2, {
      where: { id: "device-pending" },
      data: { status: "active" }
    });
    expect(prisma.gatewayInventory.update).toHaveBeenCalledWith({
      where: { id: "inventory-1" },
      data: { certificateFingerprint: PENDING_FINGERPRINT }
    });
    expect(prisma.gateway.update).toHaveBeenCalledWith({
      where: { id: "gateway-1" },
      data: { certificateFingerprint: PENDING_FINGERPRINT }
    });
  });

  it("returns success when a repeated activation already points at the same certificate", async () => {
    const { service, prisma } = createFixture({
      activationFingerprint: PENDING_FINGERPRINT,
      activationStatus: "active"
    });

    await expect(service.activateDeviceCertificate({ deviceCertificateFingerprint: PENDING_FINGERPRINT }))
      .resolves.toEqual({ status: "active" });
    expect(prisma.gatewayCertificate.update).not.toHaveBeenCalled();
  });

  it("revokes and rejects a pending device certificate after the 10-minute activation grace period", async () => {
    const { service, prisma, reconciliation } = createFixture({
      activationFingerprint: PENDING_FINGERPRINT,
      pendingCreatedAt: new Date(NOW.getTime() - 10 * 60 * 1000 - 1)
    });

    await expect(service.activateDeviceCertificate({ deviceCertificateFingerprint: PENDING_FINGERPRINT })).rejects.toThrow(
      UnauthorizedException
    );

    expect(reconciliation.armSignedCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "device", certificateSerial: "02:03", fingerprint: PENDING_FINGERPRINT, certificateId: "device-pending" })
    );
    expect(prisma.gatewayCertificate.update).toHaveBeenCalledWith({
      where: { id: "device-pending" },
      data: { status: "revocation_pending" }
    });
  });

  it("commits logical disable before worker processing and returns pending while CRL remains incomplete", async () => {
    const { service, prisma, reconciliation } = createFixture();
    prisma.certificateRevocationReconciliation.count.mockResolvedValueOnce(1);
    await expect(service.revokeInventoryCertificates("inventory-1")).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.gatewayInventory.update).toHaveBeenCalledWith({ where: { id: "inventory-1" }, data: { disabledAt: NOW } });
    expect(prisma.gateway.updateMany).toHaveBeenCalledWith({ where: { id: "gateway-1" }, data: { certificateFingerprint: null } });
    expect(reconciliation.stageInventoryRevocation).toHaveBeenCalledWith(prisma, "inventory-1", NOW);
    expect(reconciliation.processNow).toHaveBeenCalledWith("revocation-job");
    await expect(service.revokeInventoryCertificates("inventory-1")).resolves.toEqual({ revoked: 1 });
  });

  it("retries CRL publication even when every certificate is already revoked", async () => {
    const { service, reconciliation } = createFixture();
    reconciliation.processNow.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(service.revokeInventoryCertificates("inventory-1")).rejects.toThrow(ServiceUnavailableException);
    await expect(service.revokeInventoryCertificates("inventory-1")).resolves.toEqual({ revoked: 1 });
    expect(reconciliation.processNow).toHaveBeenCalledTimes(2);
  });
});

function createFixture(overrides: {
  notAfter?: Date;
  activationFingerprint?: string;
  activationStatus?: "pending" | "active";
  pendingCreatedAt?: Date;
} = {}) {
  const inventory = {
    id: "inventory-1",
    serialNumber: "GW-PROD-001",
    disabledAt: null,
    certificateFingerprint: overrides.activationStatus === "active" ? PENDING_FINGERPRINT : ACTIVE_FINGERPRINT,
    claimedGatewayId: "gateway-1",
    claimedGateway: {
      id: "gateway-1",
      certificateFingerprint: overrides.activationStatus === "active" ? PENDING_FINGERPRINT : ACTIVE_FINGERPRINT
    }
  };
  const active = {
    ...certificate("device-active", "device"),
    status: "active",
    fingerprint: ACTIVE_FINGERPRINT,
    notAfter: overrides.notAfter ?? daysFromNow(29),
    inventory
  };
  const pending = {
    ...certificate("device-pending", "device"),
    status: overrides.activationStatus ?? "pending",
    fingerprint: PENDING_FINGERPRINT,
    createdAt: overrides.pendingCreatedAt ?? NOW,
    inventory
  };
  const prisma: any = {
    gatewayCertificate: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        if (where.id === "device-active") return Promise.resolve(active);
        if (where.id === "device-pending") return Promise.resolve(pending);
        if (where.fingerprint === ACTIVE_FINGERPRINT) return Promise.resolve(active);
        if (where.fingerprint === PENDING_FINGERPRINT) return Promise.resolve(pending);
        return Promise.resolve(null);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.status === "pending" ? null : active)
      ),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "device-pending" }),
      update: jest.fn().mockResolvedValue({})
    },
    gatewayInventory: { update: jest.fn().mockResolvedValue({}) },
    gateway: { update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    certificateRevocationReconciliation: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: jest.fn().mockResolvedValue([inventory]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
  };
  const certificateAuthority = {
    signCsr: jest.fn().mockResolvedValue({
      certificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-DEVICE-CERT\n-----END CERTIFICATE-----",
      caChainPem: ["DEVICE CA"],
      certificateSerial: "02:03",
      fingerprint: PENDING_FINGERPRINT,
      issuer: "CN=Device Issuing CA",
      notBefore: NOW.toISOString(),
      notAfter: daysFromNow(365).toISOString()
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
    readCrl: jest.fn().mockImplementation((purpose) => Promise.resolve(
      `-----BEGIN X509 CRL-----\n${purpose === "device" ? "DEVICE" : "MQTT"}\n-----END X509 CRL-----\n`
    ))
  } as jest.Mocked<CertificateAuthorityProvider>;
  const csrValidator = { validate: jest.fn().mockResolvedValue({ publicKey: {} as CryptoKey }) };
  const clock = { now: () => NOW };
  const publishCrl = jest.fn().mockResolvedValue({ changed: true });
  const reconciliation = reconciliationFixture();
  return {
    service: new CertificateLifecycleService(prisma, certificateAuthority, csrValidator, clock, {
      deviceCrlPath: "/run/pki/device.crl",
      mqttCrlPath: "/run/pki/mqtt.crl",
      publishCrl
    }, reconciliation as never),
    reconciliation,
    prisma,
    certificateAuthority,
    publishCrl
  };
}

function certificate(id: string, purpose: "device" | "mqtt") {
  return {
    id,
    inventoryId: "inventory-1",
    gatewayId: "gateway-1",
    purpose,
    certificateSerial: purpose === "device" ? "02:03" : "04:05",
    fingerprint: purpose === "device" ? ACTIVE_FINGERPRINT : "CC".repeat(32),
    issuer: `${purpose} issuer`,
    status: "active",
    revokedAt: null,
    createdAt: NOW,
    notBefore: NOW,
    notAfter: daysFromNow(365)
  };
}

function daysFromNow(days: number, milliseconds = 0) {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000 + milliseconds);
}
