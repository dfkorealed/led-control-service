import { BadRequestException, ConflictException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { CertificateAuthorityProvider } from "./certificate-authority.provider";
import { GatewayCertificateService } from "./gateway-certificate.service";

const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nSECRET-MQTT-CSR\n-----END CERTIFICATE REQUEST-----";
const DEVICE_FINGERPRINT = "AA".repeat(32);
const MQTT_FINGERPRINT = "BB".repeat(32);
const NOW = new Date("2026-07-15T03:00:00.000Z");
const INVENTORY_LOCK_TIMEOUT_MS = 10_000;
const MQTT_TRANSACTION_BUDGET_MS = 140_000;

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
    expect(prisma.gatewayCertificate.update).toHaveBeenNthCalledWith(1, {
      where: { id: "mqtt-certificate-old" },
      data: { status: "replaced" }
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
    expect(prisma.gatewayCertificate.update).toHaveBeenNthCalledWith(2, {
      where: { id: "mqtt-certificate-old" },
      data: { replacedById: "mqtt-certificate-new" }
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
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
    prisma.gatewayCertificate.create.mockRejectedValueOnce(new Error("database unavailable"));

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

  it("allows a simulated six-second CA delay and configures lock timeout before the advisory lock", async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, ca, executedQueries } = createFixture();
      let markSigningStarted!: () => void;
      const signingStarted = new Promise<void>((resolve) => {
        markSigningStarted = resolve;
      });
      ca.signCsr.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            markSigningStarted();
            setTimeout(() => resolve(mqttSignedCertificate()), 6_000);
          })
      );

      const issuance = service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT });
      await signingStarted;

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: MQTT_TRANSACTION_BUDGET_MS,
        timeout: MQTT_TRANSACTION_BUDGET_MS
      });
      expect(executedQueries.map(({ template, values }) => ({ sql: template.join("?"), values }))).toEqual([
        { sql: "SELECT set_config('lock_timeout', ?, true)", values: [`${INVENTORY_LOCK_TIMEOUT_MS}ms`] },
        { sql: "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))", values: ["inventory-1"] }
      ]);

      await jest.advanceTimersByTimeAsync(6_000);
      await expect(issuance).resolves.toMatchObject({ gatewayId: "gateway-1" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not revoke when the transaction fails before CA signing", async () => {
    const { service, prisma, ca } = createFixture();
    prisma.$executeRaw.mockRejectedValueOnce(new Error("lock timeout"));

    await expect(service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })).rejects.toThrow(
      ServiceUnavailableException
    );

    expect(ca.signCsr).not.toHaveBeenCalled();
    expect(ca.revoke).not.toHaveBeenCalled();
  });

  it("best-effort revokes a signed MQTT certificate when its metadata is invalid", async () => {
    const { service, ca } = createFixture();
    ca.signCsr.mockResolvedValueOnce({
      certificatePem: "-----BEGIN CERTIFICATE-----\\nSECRET-MQTT-CERT\\n-----END CERTIFICATE-----",
      caChainPem: ["MQTT PUBLIC CA"],
      certificateSerial: "01:02",
      fingerprint: "not-a-fingerprint",
      issuer: "CN=MQTT Issuing CA",
      notBefore: "2026-07-15T00:00:00.000Z",
      notAfter: "2026-10-13T00:00:00.000Z"
    });

    await expect(service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })).rejects.toThrow(
      ServiceUnavailableException
    );

    expect(ca.revoke).toHaveBeenCalledWith({
      purpose: "mqtt",
      certificateSerial: "01:02",
      issuer: "CN=MQTT Issuing CA",
      fingerprint: "not-a-fingerprint"
    });
  });

  it.each([undefined, null, {}, []])("rejects an invalid MQTT certificate request input (%p) with 400 before signing", async (input) => {
    const { service, ca } = createFixture();

    await expect(service.issueMqttCertificate(input as never)).rejects.toThrow(BadRequestException);

    expect(ca.signCsr).not.toHaveBeenCalled();
  });

  it("serializes concurrent MQTT certificate issuance per inventory and leaves one linked active certificate", async () => {
    const { service, ca, records } = createConcurrentFixture();

    await Promise.all([
      service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT }),
      service.issueMqttCertificate({ csrPem: CSR, deviceCertificateFingerprint: DEVICE_FINGERPRINT })
    ]);

    const activeCertificates = records.filter((certificate) => certificate.status === "active");
    expect(activeCertificates).toHaveLength(1);
    expect(activeCertificates[0]).toMatchObject({ id: "mqtt-certificate-2", purpose: "mqtt" });
    expect(records).toContainEqual(
      expect.objectContaining({
        id: "mqtt-certificate-1",
        status: "replaced",
        replacedById: "mqtt-certificate-2"
      })
    );
    expect(ca.revoke).not.toHaveBeenCalled();
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
  const executedQueries: Array<{ template: string[]; values: unknown[] }> = [];
  prisma.$executeRaw = jest.fn((template: TemplateStringsArray, ...values: unknown[]) => {
    executedQueries.push({ template: Array.from(template), values });
    return Promise.resolve(0);
  });
  prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>, _options: unknown) => callback(prisma));

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
    csrValidator,
    executedQueries
  };
}

function createConcurrentFixture() {
  const records: Array<Record<string, unknown>> = [];
  let lock = Promise.resolve();
  const prisma: any = {
    gatewayCertificate: {
      findUnique: jest.fn().mockResolvedValue(baseDeviceCertificate()),
      findFirst: jest.fn(async () => records.find((certificate) => certificate.status === "active") ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const certificate = { ...data, id: `mqtt-certificate-${records.length + 1}` };
        records.push(certificate);
        return certificate;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(records.find((certificate) => certificate.id === where.id) ?? {}, data);
      })
    }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => {
    let releaseLock: (() => void) | undefined;
    let rawQueryCount = 0;
    const tx = {
      ...prisma,
      $executeRaw: jest.fn(async () => {
        rawQueryCount += 1;
        if (rawQueryCount === 1) return 0;
        const previousLock = lock;
        lock = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        await previousLock;
      })
    };

    try {
      return await callback(tx);
    } finally {
      releaseLock?.();
    }
  });

  const signed = (suffix: string) => ({
    certificatePem: `-----BEGIN CERTIFICATE-----\\nSECRET-MQTT-CERT-${suffix}\\n-----END CERTIFICATE-----`,
    caChainPem: ["MQTT PUBLIC CA"],
    certificateSerial: `01:0${suffix}`,
    fingerprint: suffix === "1" ? MQTT_FINGERPRINT : "CC".repeat(32),
    issuer: "CN=MQTT Issuing CA",
    notBefore: "2026-07-15T00:00:00.000Z",
    notAfter: "2026-10-13T00:00:00.000Z"
  });
  const ca = {
    signCsr: jest.fn().mockResolvedValueOnce(signed("1")).mockResolvedValueOnce(signed("2")),
    revoke: jest.fn().mockResolvedValue(undefined)
  } as jest.Mocked<CertificateAuthorityProvider>;
  const csrValidator = { validate: jest.fn().mockResolvedValue({ publicKey: {} as CryptoKey }) };

  return { service: new GatewayCertificateService(prisma, ca, csrValidator), ca, records };
}

function mqttSignedCertificate() {
  return {
    certificatePem: "-----BEGIN CERTIFICATE-----\nSECRET-MQTT-CERT\n-----END CERTIFICATE-----",
    caChainPem: ["MQTT PUBLIC CA"],
    certificateSerial: "01:02",
    fingerprint: MQTT_FINGERPRINT.match(/.{2}/g)?.join(":") ?? MQTT_FINGERPRINT,
    issuer: "CN=MQTT Issuing CA",
    notBefore: "2026-07-15T00:00:00.000Z",
    notAfter: "2026-10-13T00:00:00.000Z"
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
