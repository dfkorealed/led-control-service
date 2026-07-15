import { BadRequestException, ConflictException } from "@nestjs/common";
import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { rootCertificates } from "node:tls";
import { promisify } from "node:util";
import type { CertificateAuthorityProvider } from "./certificate-authority.provider";
import { ManufacturingEnrollmentService } from "./manufacturing-enrollment.service";

const scrypt = promisify(scryptCallback);
const NOW = new Date("2026-07-15T03:00:00.000Z");
const SERIAL = "GW-PROD-001";
const ENROLLMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN_SECRET = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";
const TOKEN = `${ENROLLMENT_ID}.${TOKEN_SECRET}`;
const TOKEN_HASH =
  "scrypt$00112233445566778899aabbccddeeff$21761da8c405831157395ed50142c092e9e055e23815ca9f4b0260c27414f2a395c634253ee54ff03cc27353bedc08a61e182b67e040212e61bfbe8ee11b862a";
const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nSECRET-CSR\n-----END CERTIFICATE REQUEST-----";
const DEVICE_CA_CERTIFICATE_PEM = rootCertificates[0];

interface TestInventory {
  id: string;
  serialNumber: string;
  claimCodeHash: string | null;
  certificateFingerprint: string | null;
  claimedGatewayId: string | null;
  disabledAt: Date | null;
}

describe("ManufacturingEnrollmentService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("stores only a salted scrypt hash for the 256-bit secret and returns an id.secret token once", async () => {
    const { service, prisma } = createFixture({ inventory: null });

    const result = await service.createEnrollment({ serialNumber: ` ${SERIAL} `, stationIdentity: "CN=station-01" });

    const [enrollmentId, secret] = result.enrollmentToken.split(".");
    expect(enrollmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(result).toMatchObject({ serialNumber: SERIAL, expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString() });
    expect(prisma.gatewayInventory.upsert).toHaveBeenCalledWith({
      where: { serialNumber: SERIAL },
      create: { serialNumber: SERIAL },
      update: { updatedAt: NOW }
    });
    expect(prisma.gatewayEnrollment.updateMany).toHaveBeenCalledWith({
      where: { serialNumber: SERIAL, usedAt: null },
      data: { usedAt: NOW, outcome: "superseded", failureReason: null }
    });
    const createData = prisma.gatewayEnrollment.create.mock.calls[0][0].data;
    expect(createData).toMatchObject({
      id: enrollmentId,
      serialNumber: SERIAL,
      stationIdentity: "CN=station-01",
      expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000)
    });
    expect(createData.tokenHash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expectStoredScryptHash(secret, createData.tokenHash);
    expect(createData.tokenHash).not.toContain(enrollmentId);
    expect(createData.tokenHash).not.toContain(secret);
    expect(createData.tokenHash).not.toContain(result.enrollmentToken);
    expect(JSON.stringify(createData)).not.toContain(result.enrollmentToken);
    expect(JSON.stringify(createData)).not.toContain(secret);
  });

  it("maps a concurrent active-enrollment uniqueness conflict without exposing either token", async () => {
    const { service, prisma } = createFixture({ inventory: null });
    prisma.gatewayEnrollment.create
      .mockResolvedValueOnce({ id: "winner" })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate active enrollment"), { code: "P2002" }));

    const results = await Promise.allSettled([
      service.createEnrollment({ serialNumber: SERIAL, stationIdentity: "CN=station-01" }),
      service.createEnrollment({ serialNumber: SERIAL, stationIdentity: "CN=station-02" })
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(String(rejected.reason)).toContain("active gateway enrollment already exists");
    for (const call of prisma.gatewayEnrollment.create.mock.calls) {
      expect(String(rejected.reason)).not.toContain(call[0].data.id);
      expect(String(rejected.reason)).not.toContain(call[0].data.tokenHash);
    }
  });

  it.each([
    [{ disabledAt: NOW }, "gateway inventory is disabled"],
    [{ claimedGatewayId: "gateway-1" }, "gateway inventory is already claimed"],
    [{ certificateFingerprint: "AA".repeat(32) }, "gateway already has a device certificate"]
  ])("rejects an inventory that cannot receive initial manufacturing enrollment", async (inventoryPatch, message) => {
    const { service } = createFixture({ inventory: { ...baseInventory(), ...inventoryPatch } });

    await expect(service.createEnrollment({ serialNumber: SERIAL, stationIdentity: "CN=station-01" })).rejects.toThrow(message);
  });

  it("looks up by enrollment id, verifies scrypt, and consumes before CSR validation", async () => {
    const { service, prisma, csrValidator, enrollment } = createFixture();
    csrValidator.validate.mockRejectedValue(new BadRequestException("CSR public key must be ECDSA P-256"));

    await expect(service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })).rejects.toThrow(
      "CSR public key must be ECDSA P-256"
    );

    expect(prisma.gatewayEnrollment.findUnique).toHaveBeenCalledWith({
      where: { id: ENROLLMENT_ID }
    });
    expect(prisma.gatewayEnrollment.updateMany).toHaveBeenCalledWith({
      where: {
        id: enrollment.id,
        serialNumber: SERIAL,
        usedAt: null,
        outcome: null,
        expiresAt: { gt: NOW }
      },
      data: { usedAt: NOW, outcome: "processing", failureReason: null }
    });
    expect(enrollment).toMatchObject({ usedAt: NOW, outcome: "failed", failureReason: "csr_invalid" });
    await expect(service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })).rejects.toThrow(
      "enrollment token is not active"
    );
  });

  it("terminally consumes serial mismatch and rejects later reuse with the correct serial", async () => {
    const serialMismatch = createFixture();
    await expect(
      serialMismatch.service.enrollDevice({ serialNumber: "GW-OTHER", token: TOKEN, csrPem: CSR })
    ).rejects.toThrow("enrollment token is not active");
    expect(serialMismatch.enrollment).toMatchObject({ usedAt: NOW, outcome: "failed", failureReason: "serial_mismatch" });
    await expect(
      serialMismatch.service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })
    ).rejects.toThrow("enrollment token is not active");
    expect(serialMismatch.csrValidator.validate).not.toHaveBeenCalled();
  });

  it("terminally consumes an expired token", async () => {
    const expired = createFixture({ enrollment: { expiresAt: new Date(NOW.getTime() - 1) } });
    await expect(expired.service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })).rejects.toThrow(
      "enrollment token is not active"
    );
    expect(expired.enrollment).toMatchObject({ usedAt: NOW, outcome: "failed", failureReason: "token_expired" });
  });

  it.each([
    ["malformed", "not-an-enrollment-token"],
    ["unknown", `00000000-0000-4000-8000-000000000000.${TOKEN_SECRET}`],
    ["wrong secret", `${ENROLLMENT_ID}.${Buffer.alloc(32, 0x43).toString("base64url")}`]
  ])("generalizes %s token rejection", async (_case, token) => {
    const { service, prisma } = createFixture();

    await expect(service.enrollDevice({ serialNumber: SERIAL, token, csrPem: CSR })).rejects.toThrow(
      "enrollment token is not active"
    );
    expect(prisma.gatewayEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it("allows only one concurrent use of the same token", async () => {
    const { service, ca } = createFixture();

    const results = await Promise.allSettled([
      service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR }),
      service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("enrollment token is not active");
    expect(ca.signCsr).toHaveBeenCalledTimes(1);
  });

  it("issues a server-constrained device certificate and persists metadata and pointers atomically", async () => {
    const { service, prisma, ca, enrollment } = createFixture();

    const result = await service.enrollDevice({ serialNumber: ` ${SERIAL} `, token: TOKEN, csrPem: CSR });

    expect(ca.signCsr).toHaveBeenCalledWith({
      purpose: "device",
      csrPem: CSR,
      commonName: SERIAL,
      uriSans: [`urn:dfkorea:gateway:${SERIAL}`],
      ttlSeconds: 365 * 24 * 60 * 60
    });
    expect(result).toMatchObject({
      deviceCertificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-CERT\n-----END CERTIFICATE-----",
      deviceCaBundlePem: DEVICE_CA_CERTIFICATE_PEM,
      apiCaBundlePem: "API PUBLIC CA",
      mqttCaBundlePem: "MQTT PUBLIC CA"
    });
    expect(Buffer.from(result.claimCode, "base64url")).toHaveLength(32);
    expect(prisma.gatewayCertificate.create).toHaveBeenCalledWith({
      data: {
        inventoryId: "inventory-1",
        purpose: "device",
        certificateSerial: "0102",
        fingerprint: "AA".repeat(32),
        issuer: "CN=Device Issuing CA",
        notBefore: new Date("2026-07-15T00:00:00.000Z"),
        notAfter: new Date("2027-07-15T00:00:00.000Z"),
        status: "active"
      }
    });
    expect(prisma.gatewayInventory.updateMany).toHaveBeenCalledWith({
      where: {
        id: "inventory-1",
        claimedGatewayId: null,
        disabledAt: null,
        certificateFingerprint: null
      },
      data: {
        certificateFingerprint: "AA".repeat(32),
        claimCodeHash: expect.stringMatching(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
      }
    });
    expect(enrollment).toMatchObject({ usedAt: NOW, outcome: "issued", failureReason: null });

    const databaseCalls = JSON.stringify({
      certificate: prisma.gatewayCertificate.create.mock.calls,
      inventory: prisma.gatewayInventory.updateMany.mock.calls,
      enrollment: prisma.gatewayEnrollment.update.mock.calls
    });
    expect(databaseCalls).not.toContain(TOKEN);
    expect(databaseCalls).not.toContain(CSR);
    expect(databaseCalls).not.toContain("SECRET-CERT");
    expect(databaseCalls).not.toContain(result.claimCode);
  });

  it.each([
    ["empty", []],
    ["non-certificate", ["DEVICE PUBLIC CA"]],
    ["partially invalid", [DEVICE_CA_CERTIFICATE_PEM, "not a certificate"]]
  ])("rejects a %s device CA chain before recording issuance", async (_case, caChainPem) => {
    const { service, prisma, ca, enrollment } = createFixture();
    ca.signCsr.mockResolvedValue({ ...signedCertificate(), caChainPem });

    await expect(service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })).rejects.toThrow(
      "device certificate enrollment failed"
    );

    expect(prisma.gatewayCertificate.create).not.toHaveBeenCalled();
    expect(ca.revoke).toHaveBeenCalledWith({
      purpose: "device",
      certificateSerial: "01:02",
      issuer: "CN=Device Issuing CA",
      fingerprint: fingerprintWithColons("AA".repeat(32))
    });
    expect(enrollment).toMatchObject({ usedAt: NOW, outcome: "failed", failureReason: "certificate_signing_failed" });
  });

  it("keeps the token consumed when Vault signing fails", async () => {
    const { service, ca, enrollment } = createFixture();
    ca.signCsr.mockRejectedValue(new Error(`Vault failed with ${CSR}`));

    const error = await service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR }).catch((caught: unknown) => caught);

    expect(String(error)).toContain("device certificate enrollment failed");
    expect(String(error)).not.toContain(CSR);
    expect(enrollment).toMatchObject({ usedAt: NOW, outcome: "failed", failureReason: "certificate_signing_failed" });
    await expect(service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })).rejects.toThrow(
      "enrollment token is not active"
    );
  });

  it("best-effort revokes an issued certificate when the persistence transaction fails", async () => {
    const { service, prisma, ca, enrollment } = createFixture();
    prisma.$transaction.mockRejectedValueOnce(new Error(`database failed with ${TOKEN}`));

    const error = await service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR }).catch((caught: unknown) => caught);

    expect(ca.revoke).toHaveBeenCalledWith({
      purpose: "device",
      certificateSerial: "01:02",
      issuer: "CN=Device Issuing CA",
      fingerprint: fingerprintWithColons("AA".repeat(32))
    });
    expect(String(error)).toContain("device certificate enrollment failed");
    expect(String(error)).not.toContain(TOKEN);
    expect(enrollment).toMatchObject({ usedAt: NOW, outcome: "failed", failureReason: "persistence_failed" });

    ca.revoke.mockRejectedValueOnce(new Error("revoke unavailable"));
    await expect(service.enrollDevice({ serialNumber: SERIAL, token: TOKEN, csrPem: CSR })).rejects.toThrow(
      "enrollment token is not active"
    );
  });
});

function createFixture(overrides: {
  inventory?: TestInventory | null;
  enrollment?: Partial<ReturnType<typeof baseEnrollment>>;
} = {}) {
  const inventory = overrides.inventory === undefined ? baseInventory() : overrides.inventory;
  const enrollment = { ...baseEnrollment(), ...overrides.enrollment };
  const prisma: any = {
    gatewayInventory: {
      findUnique: jest.fn().mockResolvedValue(inventory),
      create: jest.fn().mockResolvedValue(baseInventory()),
      upsert: jest.fn().mockResolvedValue(inventory ?? baseInventory()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    gatewayEnrollment: {
      findUnique: jest.fn(async ({ where }: any) => where.id === enrollment.id ? enrollment : null),
      create: jest.fn().mockResolvedValue({ id: "enrollment-new" }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!where.id) return { count: 1 };
        if (where.usedAt === null && enrollment.usedAt) return { count: 0 };
        if (where.outcome === null && enrollment.outcome !== null) return { count: 0 };
        if (where.expiresAt?.gt && enrollment.expiresAt <= where.expiresAt.gt) return { count: 0 };
        if (where.serialNumber && where.serialNumber !== enrollment.serialNumber) return { count: 0 };
        Object.assign(enrollment, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(enrollment, data);
        return enrollment;
      })
    },
    gatewayCertificate: { create: jest.fn().mockResolvedValue({ id: "certificate-1" }) }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));

  const ca = {
    signCsr: jest.fn().mockResolvedValue(signedCertificate()),
    revoke: jest.fn().mockResolvedValue(undefined)
  } as jest.Mocked<CertificateAuthorityProvider>;
  const csrValidator = { validate: jest.fn().mockResolvedValue({ publicKey: {} as CryptoKey }) };
  const service = new ManufacturingEnrollmentService(prisma, ca, csrValidator, {
    apiCaBundlePem: "API PUBLIC CA",
    mqttCaBundlePem: "MQTT PUBLIC CA",
    manufacturingCaFingerprint: "BB".repeat(32)
  });
  return { service, prisma, ca, csrValidator, inventory, enrollment };
}

function baseInventory(): TestInventory {
  return {
    id: "inventory-1",
    serialNumber: SERIAL,
    claimCodeHash: null,
    certificateFingerprint: null,
    claimedGatewayId: null,
    disabledAt: null
  };
}

function baseEnrollment() {
  return {
    id: ENROLLMENT_ID,
    serialNumber: SERIAL,
    tokenHash: TOKEN_HASH,
    expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000),
    usedAt: null as Date | null,
    stationIdentity: "CN=station-01",
    outcome: null as string | null,
    failureReason: null as string | null
  };
}

function signedCertificate() {
  return {
    certificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-CERT\n-----END CERTIFICATE-----",
    caChainPem: [DEVICE_CA_CERTIFICATE_PEM],
    certificateSerial: "01:02",
    fingerprint: fingerprintWithColons("AA".repeat(32)),
    issuer: "CN=Device Issuing CA",
    notBefore: "2026-07-15T00:00:00.000Z",
    notAfter: "2027-07-15T00:00:00.000Z"
  };
}

function fingerprintWithColons(value: string) {
  return value.match(/.{2}/g)?.join(":") ?? value;
}

async function expectStoredScryptHash(secret: string, storedHash: string) {
  const [algorithm, salt, storedHex] = storedHash.split("$");
  const stored = Buffer.from(storedHex, "hex");
  const candidate = (await scrypt(secret, salt, stored.length)) as Buffer;

  expect(algorithm).toBe("scrypt");
  expect(timingSafeEqual(stored, candidate)).toBe(true);
}
