import { ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CertificateRevocationReconciliationService } from "./certificate-revocation-reconciliation.service";
import { lockGatewayCertificates, lockGatewayInventory } from "./inventory-certificate-lock";

const NOW = new Date("2026-09-12T00:00:00.000Z");
const metadata = {
  inventoryId: "inventory-1", purpose: "device" as const,
  issuer: "device-ca", certificateSerial: "AA01", fingerprint: "AB".repeat(32),
  source: "signed_certificate" as const
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1", ...metadata, certificateId: null, attempts: 1,
    nextAttemptAt: NOW, leaseOwner: "claim-1", leaseExpiresAt: new Date(NOW.getTime() + 300_000),
    revokedAt: null, completedAt: null, cancelledAt: null, lastError: null,
    createdAt: NOW, updatedAt: NOW, ...overrides
  };
}

function setup() {
  const rows: any[] = [];
  const ledger = {
    createMany: jest.fn(async ({ data }: any) => {
      if (!rows.some(row => row.fingerprint === data.fingerprint ||
        (row.issuer === data.issuer && row.certificateSerial === data.certificateSerial))) {
        rows.push(job({ ...data, id: "job-1", leaseOwner: null, leaseExpiresAt: null, attempts: 0 }));
      }
      return { count: 1 };
    }),
    findFirst: jest.fn(async ({ where }: any) => rows.find(row => where.OR.some((key: any) =>
      Object.entries(key).every(([field, value]) => row[field] === value))) ?? null),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...job(), ...data }))
  };
  const tx: any = {
    certificateRevocationReconciliation: ledger,
    gatewayCertificate: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    gatewayInventory: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([])
  };
  const prisma: any = { ...tx, $transaction: jest.fn(async (callback: any) => callback(tx)) };
  const ca = { signCsr: jest.fn(), revoke: jest.fn().mockResolvedValue(undefined), readCrl: jest.fn().mockResolvedValue("fixture-crl") };
  const config = { deviceCrlPath: "/test/device.crl", mqttCrlPath: "/test/mqtt.crl", publishCrl: jest.fn().mockResolvedValue(undefined) };
  const service = new CertificateRevocationReconciliationService(prisma, ca, config);
  return { service, prisma, tx, ledger, rows, ca, config };
}

describe("CertificateRevocationReconciliationService", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
  afterEach(() => { jest.useRealTimers(); });

  it("arms normalized metadata once by issuer+serial or fingerprint without persisting signed material", async () => {
    const { service, rows, ledger } = setup();
    const first = await service.armSignedCertificate({ ...metadata, certificateSerial: "aa:01", fingerprint: metadata.fingerprint.toLowerCase(),
      certificatePem: "private-fixture-certificate", csrPem: "private-fixture-csr", privateKey: "private-fixture-key" } as any);
    const bySerial = await service.armSignedCertificate({ ...metadata, fingerprint: "CD".repeat(32) });
    const byFingerprint = await service.armSignedCertificate({ ...metadata, certificateSerial: "BB02" });
    expect([first, bySerial, byFingerprint]).toEqual(["job-1", "job-1", "job-1"]);
    expect(rows).toHaveLength(1);
    expect(ledger.createMany.mock.calls[0][0]).toEqual({ skipDuplicates: true, data: {
      ...metadata, certificateId: null, nextAttemptAt: new Date("2026-09-12T00:03:00.000Z")
    } });
  });

  it("sanitizes untrusted source strings to a fixed code", async () => {
    const { service, rows } = setup();
    await service.armSignedCertificate({ ...metadata, source: "SECRET-CSR" } as any);
    expect(rows[0].source).toBe("signed_certificate");
  });

  it("attempts immediate CA revoke and returns a generic 503 when arming cannot commit", async () => {
    const { service, prisma, ca } = setup();
    prisma.$transaction.mockRejectedValue(new Error("SECRET-DB-DETAIL"));
    ca.revoke.mockRejectedValue(new Error("SECRET-CA-DETAIL"));
    await expect(service.armSignedCertificate(metadata)).rejects.toThrow(ServiceUnavailableException);
    expect(ca.revoke).toHaveBeenCalledWith({ purpose: "device", issuer: "device-ca", certificateSerial: "AA01", fingerprint: metadata.fingerprint });
  });

  it("cancels only an unclaimed live obligation in the caller certificate transaction", async () => {
    const { service, tx, ledger, prisma } = setup();
    await service.cancelSignedCertificate(tx, "job-1");
    expect(ledger.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", cancelledAt: null, completedAt: null, revokedAt: null, leaseOwner: null },
      data: { cancelledAt: NOW }
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses certificate persistence when the revocation job has been claimed", async () => {
    const { service, tx, ledger } = setup();
    ledger.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancelSignedCertificate(tx, "job-1")).rejects.toThrow(ServiceUnavailableException);
  });

  it("claims due work with skip-locked rows, excluding cancelled/completed and live leases", async () => {
    const { service, tx, ca } = setup();
    await service.processNow("job-1");
    const sql = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql.text).toContain('"cancelledAt" IS NULL');
    expect(sql.text).toContain('"completedAt" IS NULL');
    expect(sql.text).toContain('"nextAttemptAt" <=');
    expect(sql.text).toContain('"leaseExpiresAt" <=');
    expect(sql.values).toContain("job-1");
    expect(ca.revoke).not.toHaveBeenCalled();
  });

  it("records revoke before CRL failure, then retries CRL only and completes the certificate", async () => {
    const { service, tx, ledger, ca, config } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job()]);
    config.publishCrl.mockRejectedValueOnce(new Error("SECRET-CRL-ERROR"));
    await service.processNow("job-1");
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: NOW, lastError: null } }));
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      lastError: "crl_publish_failed", nextAttemptAt: new Date("2026-09-12T00:00:30.000Z"), leaseOwner: null, leaseExpiresAt: null
    }) }));
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW, certificateId: "certificate-1", attempts: 2 })]);
    await service.processNow("job-1");
    expect(ca.revoke).toHaveBeenCalledTimes(1);
    expect(config.publishCrl).toHaveBeenLastCalledWith("/test/device.crl", "fixture-crl");
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completedAt: NOW }) }));
    expect(tx.gatewayCertificate.updateMany).toHaveBeenCalledWith({
      where: { id: "certificate-1", inventoryId: "inventory-1", fingerprint: metadata.fingerprint },
      data: { status: "revoked", revokedAt: NOW }
    });
  });

  it("fences every result by claim owner and unexpired lease", async () => {
    const { service, tx, ledger, config } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job()]);
    ledger.updateMany.mockResolvedValue({ count: 0 });
    await service.processNow("job-1");
    expect(ledger.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", leaseOwner: "claim-1", leaseExpiresAt: { gt: NOW }, cancelledAt: null, completedAt: null },
      data: { revokedAt: NOW, lastError: null }
    });
    expect(config.publishCrl).not.toHaveBeenCalled();
    expect(tx.gatewayCertificate.updateMany).not.toHaveBeenCalled();
  });

  it("does not mutate a certificate after losing the completion lease", async () => {
    const { service, tx, ledger } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW, certificateId: "certificate-1" })]);
    ledger.updateMany.mockResolvedValue({ count: 0 });
    await service.processNow("job-1");
    expect(tx.gatewayCertificate.updateMany).not.toHaveBeenCalled();
  });

  it("uses the time after a slow CA response for lease fencing", async () => {
    const { service, tx, ledger, ca } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job()]);
    ca.revoke.mockImplementation(async () => { jest.setSystemTime(new Date("2026-09-12T00:06:00.000Z")); });
    ledger.updateMany.mockResolvedValue({ count: 0 });
    await service.processNow("job-1");
    expect(ledger.updateMany.mock.calls[0][0].where.leaseExpiresAt).toEqual({ gt: new Date("2026-09-12T00:06:00.000Z") });
  });

  it.each([[1, "2026-09-12T00:00:30.000Z"], [3, "2026-09-12T00:02:00.000Z"], [100, "2026-09-12T01:00:00.000Z"]])(
    "retries revoke attempt %s indefinitely with bounded exponential delay", async (attempts, expected) => {
      const { service, tx, ledger, ca } = setup();
      tx.$queryRaw.mockResolvedValueOnce([job({ attempts })]);
      ca.revoke.mockRejectedValue(new Error("SECRET-CA-ERROR"));
      await service.processNow("job-1");
      expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        nextAttemptAt: new Date(expected), lastError: "ca_revoke_failed", leaseOwner: null
      }) }));
    }
  );

  it("keeps a CRL obligation pending when the publication destination is absent", async () => {
    const { service, tx, ledger, config } = setup();
    config.deviceCrlPath = undefined as any;
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW })]);
    await service.processNow("job-1");
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastError: "crl_publish_failed" }) }));
    expect(config.publishCrl).not.toHaveBeenCalled();
  });

  it("stages logical revocation and reopens the previously cancelled signed obligation", async () => {
    const { service, tx, ledger, rows } = setup();
    rows.push(job({ cancelledAt: NOW, leaseOwner: null }));
    tx.$queryRaw.mockResolvedValueOnce([{ id: "inventory-1" }]).mockResolvedValueOnce([
      { ...metadata, id: "certificate-1", status: "active", revokedAt: null },
      { ...metadata, id: "certificate-2", status: "revoked", revokedAt: NOW }
    ]);
    await service.stageInventoryRevocation(tx, "inventory-1", NOW);
    expect(tx.gatewayInventory.updateMany).toHaveBeenCalledWith({ where: { id: "inventory-1" }, data: { certificateFingerprint: null } });
    expect(tx.gatewayCertificate.updateMany).toHaveBeenCalledWith({ where: { id: "certificate-1", status: { not: "revoked" } }, data: { status: "revocation_pending" } });
    expect(ledger.updateMany).toHaveBeenCalledWith({ where: { id: "job-1", completedAt: null }, data: {
      certificateId: "certificate-1", cancelledAt: null, nextAttemptAt: NOW, source: "inventory_revocation"
    } });
  });

  it("recovers on startup and polls every 30 seconds until shutdown", async () => {
    const { service, tx } = setup();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("inventory certificate locks", () => {
  it("locks the inventory advisory key before inventory row and sorted certificate rows", async () => {
    const { tx } = setup();
    await lockGatewayInventory(tx, "inventory-1");
    await lockGatewayCertificates(tx, "inventory-1");
    const queries = [...tx.$executeRaw.mock.calls.map((call: any[]) => ({ order: tx.$executeRaw.mock.invocationCallOrder[tx.$executeRaw.mock.calls.indexOf(call)], text: call[0].text })),
      ...tx.$queryRaw.mock.calls.map((call: any[]) => ({ order: tx.$queryRaw.mock.invocationCallOrder[tx.$queryRaw.mock.calls.indexOf(call)], text: call[0].text }))]
      .sort((a, b) => a.order - b.order).map(query => query.text);
    expect(queries[0]).toContain("set_config('lock_timeout'");
    expect(queries[1]).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(queries[2]).toContain('FROM "GatewayInventory"');
    expect(queries[2]).toContain("FOR UPDATE");
    expect(queries[3]).toContain('ORDER BY "id" FOR UPDATE');
  });
});
