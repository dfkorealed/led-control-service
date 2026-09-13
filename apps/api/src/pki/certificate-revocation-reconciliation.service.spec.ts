import { ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CertificateRevocationReconciliationService } from "./certificate-revocation-reconciliation.service";
import { createTestCrl } from "./crl.test-support";
import { lockGatewayCertificates, lockGatewayInventory } from "./inventory-certificate-lock";

const NOW = new Date("2026-09-12T00:00:00.000Z");
const metadata = {
  inventoryId: "inventory-1", purpose: "device" as const,
  issuer: "device-ca", certificateSerial: "AA01", fingerprint: "AB".repeat(32),
  source: "signed_certificate" as const
};

let crlAa01: string;
let crlBb02: string;
let crlBoth: string;
let rootCrl: string;
let changingCrls: string[];

beforeAll(async () => {
  crlAa01 = await createTestCrl(["AA01"], "CN=Test Intermediate", 0);
  crlBb02 = await createTestCrl(["BB02"], "CN=Test Intermediate", 1);
  crlBoth = await createTestCrl(["AA01", "BB02"], "CN=Test Intermediate", 2);
  rootCrl = await createTestCrl([], "CN=Test Root", 0);
  changingCrls = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    createTestCrl(["AA01"], "CN=Test Intermediate", index + 3)));
});

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
    findFirst: jest.fn(async ({ where }: any) => where.id ? { id: where.id } : rows.find(row => where.OR.some((key: any) =>
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
  const ca = {
    signCsr: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
    rebuildCrl: jest.fn().mockResolvedValue(undefined),
    readCrl: jest.fn().mockImplementation(async () => crlAa01)
  };
  const config = {
    deviceCrlPath: "/test/device.crl",
    mqttCrlPath: "/test/mqtt.crl",
    trustedRootCrlPem: rootCrl,
    publishCrl: jest.fn().mockResolvedValue(undefined)
  };
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
    expect(config.publishCrl).toHaveBeenLastCalledWith("/test/device.crl", crlAa01, rootCrl);
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

  it.each([
    ["device", "/test/device.crl"],
    ["mqtt", "/test/mqtt.crl"]
  ] as const)("forces a fresh %s CRL before reading and publishing it", async (purpose, path) => {
    const { service, tx, ca, config, ledger } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ purpose, revokedAt: NOW })]);
    let rebuilt = false;
    ca.rebuildCrl.mockImplementation(async () => { rebuilt = true; });
    ca.readCrl.mockImplementation(async () => rebuilt ? crlAa01 : crlBb02);

    await service.processNow("job-1");

    expect(ca.rebuildCrl).toHaveBeenCalledWith(purpose);
    expect(ca.rebuildCrl.mock.invocationCallOrder[0]).toBeLessThan(ca.readCrl.mock.invocationCallOrder[0]);
    expect(config.publishCrl).toHaveBeenCalledWith(path, crlAa01, rootCrl);
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ completedAt: NOW })
    }));
  });

  it.each(["device", "mqtt"] as const)("keeps a %s job pending when the fetched CRL omits its exact serial", async purpose => {
    const { service, tx, ca, config, ledger } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ purpose, revokedAt: NOW })]);
    ca.readCrl.mockResolvedValue(crlBb02);

    await service.processNow("job-1");

    expect(config.publishCrl).not.toHaveBeenCalled();
    expect(ledger.updateMany.mock.calls.every(([input]) => !input.data.completedAt)).toBe(true);
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: "crl_publish_failed", leaseOwner: null, leaseExpiresAt: null })
    }));
  });

  it("re-reads the CA after publication and replaces a snapshot that became stale before completion", async () => {
    const { service, tx, ca, config, ledger } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW })]);
    ca.readCrl.mockResolvedValueOnce(crlAa01).mockResolvedValue(crlBoth);
    await service.processNow("job-1");
    expect(config.publishCrl.mock.calls).toEqual([
      ["/test/device.crl", crlAa01, rootCrl], ["/test/device.crl", crlBoth, rootCrl]
    ]);
    expect(ca.readCrl).toHaveBeenCalledTimes(3);
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completedAt: NOW }) }));
  });

  it("backs off after three changing CRL publications instead of extending the publication transaction indefinitely", async () => {
    const { service, tx, ca, config, ledger } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW })]);
    let version = 0;
    ca.readCrl.mockImplementation(async () => {
      version += 1;
      if (version > 6) throw new Error("CA fixture unavailable after six versions");
      return changingCrls[version - 1];
    });
    await service.processNow("job-1");
    expect(config.publishCrl).toHaveBeenCalledTimes(3);
    expect(ca.readCrl).toHaveBeenCalledTimes(4);
    expect(ledger.updateMany.mock.calls.every(([input]) => !input.data.completedAt)).toBe(true);
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      lastError: "crl_publish_failed", nextAttemptAt: new Date("2026-09-12T00:00:30.000Z")
    }) }));
  });

  it("does not begin publishing after a transaction timeout during the CA read", async () => {
    const { service, tx, ledger, config } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW })]);
    ledger.findFirst.mockRejectedValue(new Error("Transaction already closed"));
    await service.processNow("job-1");
    expect(config.publishCrl).not.toHaveBeenCalled();
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastError: "crl_publish_failed" }) }));
  });

  it("leaves publication uncompleted when it loses the lease before publishing", async () => {
    const { service, tx, ledger, config } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW })]);
    ledger.findFirst.mockResolvedValue(null);
    await service.processNow("job-1");
    expect(config.publishCrl).not.toHaveBeenCalled();
    expect(ledger.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a post-publish crash uncompleted and a restarted worker re-reads and publishes the latest CRL", async () => {
    const { service, prisma, tx, ledger, ca, config } = setup();
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW })]);
    ca.readCrl.mockResolvedValueOnce(crlAa01).mockRejectedValueOnce(new Error("publication interrupted before confirmation"));
    await service.processNow("job-1");
    expect(config.publishCrl).toHaveBeenCalledWith("/test/device.crl", crlAa01, rootCrl);
    expect(ledger.updateMany.mock.calls.every(([input]) => !input.data.completedAt)).toBe(true);
    tx.$queryRaw.mockResolvedValueOnce([job({ revokedAt: NOW, leaseOwner: "restarted-claim", attempts: 2 })]);
    ca.readCrl.mockResolvedValue(crlBoth);
    const restarted = new CertificateRevocationReconciliationService(prisma, ca, config);
    await restarted.processNow("job-1");
    expect(config.publishCrl).toHaveBeenLastCalledWith("/test/device.crl", crlBoth, rootCrl);
    expect(ledger.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseOwner: "restarted-claim" }), data: expect.objectContaining({ completedAt: NOW })
    }));
    expect(ca.revoke).not.toHaveBeenCalled();
    expect(ca.rebuildCrl).toHaveBeenCalledTimes(2);
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Model only the external DB boundary: two service instances share committed
// rows and PostgreSQL's transaction-scoped advisory key space. Production claim,
// CA read/publish order and lease predicates all run through the real service.
function concurrentWorkers(secondPurpose: "device" | "mqtt" = "device") {
  const rows = [job({ id: "job-a", leaseOwner: "claim-a", certificateSerial: "AA01" }),
    job({ id: "job-b", leaseOwner: "claim-b", certificateSerial: "BB02", purpose: secondPurpose })];
  const locks = new Map<string, Promise<void>>();
  const firstPublishStarted = deferred();
  const releaseFirstPublish = deferred();
  const secondRevoked = deferred();
  const firstFinalizeStarted = deferred();
  const releaseFirstFinalize = deferred();
  let holdFinalization = false;
  const published = new Map<string, string>();
  const revoked: string[] = [];
  const ca = {
    signCsr: jest.fn(),
    revoke: jest.fn(async ({ certificateSerial }: any) => {
      revoked.push(certificateSerial);
      if (certificateSerial === "BB02") secondRevoked.resolve();
    }),
    rebuildCrl: jest.fn().mockResolvedValue(undefined),
    readCrl: jest.fn(async () => revoked.includes("BB02") ? crlBoth : crlAa01)
  };
  const config = {
    deviceCrlPath: "/test/device.crl", mqttCrlPath: "/test/mqtt.crl",
    trustedRootCrlPem: rootCrl,
    publishCrl: jest.fn(async (path: string, crl: string) => {
      if (crl === crlAa01) {
        firstPublishStarted.resolve();
        await releaseFirstPublish.promise;
      }
      published.set(path, crl);
      return { changed: true as const };
    })
  };
  const updateMany = jest.fn(async ({ where, data }: any) => {
    if (where.id === "job-a" && data.completedAt && holdFinalization) {
      firstFinalizeStarted.resolve();
      await releaseFirstFinalize.promise;
    }
    const row = rows.find(item => item.id === where.id)!;
    if (row.leaseOwner !== where.leaseOwner || row.completedAt !== null || row.cancelledAt !== null ||
      !row.leaseExpiresAt || row.leaseExpiresAt <= where.leaseExpiresAt.gt) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const findFirst = async ({ where }: any) => {
    const row = rows.find(item => item.id === where.id)!;
    return row.leaseOwner === where.leaseOwner && row.completedAt === null && row.cancelledAt === null &&
      row.leaseExpiresAt && row.leaseExpiresAt > where.leaseExpiresAt.gt ? { id: row.id } : null;
  };
  const prisma: any = {
    certificateRevocationReconciliation: { updateMany },
    $transaction: async (callback: any, options?: { timeout?: number }) => {
      const releases: Array<() => void> = [];
      let active = true;
      const assertActive = () => { if (!active) throw new Error("Transaction already closed"); };
      const timeout = setTimeout(() => {
        active = false;
        releases.forEach(release => release());
      }, options?.timeout ?? 5_000);
      const tx = {
        certificateRevocationReconciliation: {
          updateMany: (input: any) => { assertActive(); return updateMany(input); },
          findFirst: (input: any) => { assertActive(); return findFirst(input); }
        },
        $queryRaw: async (sql: Prisma.Sql) => {
          const row = rows.find(item => sql.values.includes(item.id));
          return row ? [{ ...row }] : [];
        },
        $executeRaw: async (sql: Prisma.Sql) => {
          if (sql.text.includes("pg_advisory_xact_lock")) {
            const key = JSON.stringify(sql.values);
            const previous = locks.get(key) ?? Promise.resolve();
            const release = deferred();
            locks.set(key, previous.then(() => release.promise));
            await previous;
            releases.push(release.resolve);
          }
          return 1;
        }
      };
      try { return await callback(tx); } finally { clearTimeout(timeout); active = false; releases.forEach(release => release()); }
    }
  };
  const a = new CertificateRevocationReconciliationService(prisma, ca, config);
  const b = new CertificateRevocationReconciliationService(prisma, ca, config);
  return { a, b, rows, ca, published, firstPublishStarted, releaseFirstPublish, secondRevoked,
    firstFinalizeStarted, releaseFirstFinalize, holdFinalization: () => { holdFinalization = true; } };
}

describe("CRL publication across worker instances", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
  afterEach(() => { jest.useRealTimers(); });

  it("serializes same-purpose reads and publishes so a delayed snapshot cannot overwrite a newer CRL", async () => {
    const state = concurrentWorkers();
    const first = state.a.processNow("job-a");
    await state.firstPublishStarted.promise;
    const second = state.b.processNow("job-b");
    await state.secondRevoked.promise;
    await jest.advanceTimersByTimeAsync(0);
    const readsWhileFirstPublishes = state.ca.readCrl.mock.calls.length;
    state.releaseFirstPublish.resolve();
    await Promise.all([first, second]);
    expect(readsWhileFirstPublishes).toBe(1);
    expect(state.published.get("/test/device.crl")).toBe(crlBoth);
    expect(state.rows.map(row => row.completedAt)).toEqual([NOW, NOW]);
  });

  it("refreshes the final CRL after a stale lease holder publishes, without completing its stale row", async () => {
    const state = concurrentWorkers();
    const first = state.a.processNow("job-a");
    await state.firstPublishStarted.promise;
    // Another claim can be eligible while the old worker still owns the CRL
    // transaction. Its row lease is deliberately shorter than the blocked I/O.
    state.rows[0].leaseExpiresAt = new Date(NOW.getTime() - 1);
    const second = state.b.processNow("job-b");
    await state.secondRevoked.promise;
    await jest.advanceTimersByTimeAsync(0);
    state.releaseFirstPublish.resolve();
    await Promise.all([first, second]);
    expect(state.rows[0].completedAt).toBeNull();
    expect(state.rows[1].completedAt).toEqual(NOW);
    expect(state.published.get("/test/device.crl")).toBe(crlBoth);
  });

  it("holds the purpose lock through fenced finalization", async () => {
    const state = concurrentWorkers();
    state.holdFinalization();
    const first = state.a.processNow("job-a");
    await state.firstPublishStarted.promise;
    state.releaseFirstPublish.resolve();
    await state.firstFinalizeStarted.promise;
    const second = state.b.processNow("job-b");
    await state.secondRevoked.promise;
    await jest.advanceTimersByTimeAsync(0);
    const readsWhileFinalizing = state.ca.readCrl.mock.calls.length;
    state.releaseFirstFinalize.resolve();
    await Promise.all([first, second]);
    expect(readsWhileFinalizing).toBe(2);
    expect(state.published.get("/test/device.crl")).toBe(crlBoth);
  });

  it("lets MQTT finish while device publication is blocked", async () => {
    const state = concurrentWorkers("mqtt");
    const first = state.a.processNow("job-a");
    await state.firstPublishStarted.promise;
    const second = state.b.processNow("job-b");
    await state.secondRevoked.promise;
    await jest.advanceTimersByTimeAsync(0);
    const mqttCompletedWhileDeviceBlocked = state.rows[1].completedAt;
    state.releaseFirstPublish.resolve();
    await Promise.all([first, second]);
    expect(mqttCompletedWhileDeviceBlocked).toEqual(NOW);
    expect(state.published.get("/test/mqtt.crl")).toBe(crlBoth);
  });

  it("keeps the publication lock beyond a row lease so a successor claim of that same row publishes last", async () => {
    const state = concurrentWorkers();
    const first = state.a.processNow("job-a");
    await state.firstPublishStarted.promise;
    // A normal bounded publication can outlive the 5-minute row lease. The
    // advisory transaction must still own the file while its I/O completes.
    await jest.advanceTimersByTimeAsync(301_000);
    await state.ca.revoke({ certificateSerial: "BB02" });
    const resumedAt = new Date("2026-09-12T00:05:01.000Z");
    Object.assign(state.rows[0], { leaseOwner: "successor-claim", leaseExpiresAt: new Date("2026-09-12T00:10:01.000Z") });
    const successor = state.b.processNow("job-a");
    await jest.advanceTimersByTimeAsync(0);
    const readsWhilePredecessorPublishes = state.ca.readCrl.mock.calls.length;
    state.releaseFirstPublish.resolve();
    await Promise.all([first, successor]);
    expect(readsWhilePredecessorPublishes).toBe(1);
    expect(state.published.get("/test/device.crl")).toBe(crlBoth);
    expect(state.rows[0].completedAt).toEqual(resumedAt);
  });
});
