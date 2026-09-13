import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { GatewayCertificateService } from "./gateway-certificate.service";
import { CertificateLifecycleService } from "./certificate-lifecycle.service";
import { CertificateRevocationReconciliationService } from "./certificate-revocation-reconciliation.service";
import { GatewayOnboardingService } from "../gateway-onboarding/gateway-onboarding.service";
import { ManufacturingEnrollmentService } from "./manufacturing-enrollment.service";
import { rootCertificates } from "node:tls";
import { OperatorSiteAdminsService } from "../operator-site-admins/operator-site-admins.service";
import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import { createTestCrl } from "./crl.test-support";

const databaseUrl = process.env.PKI_CONCURRENCY_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const ACTIVE = "AA".repeat(32);
const PENDING = "BB".repeat(32);
const operator = { id: "operator", role: "operator", status: "active", organizationType: "service_provider" };
const validator = { validate: async () => ({ publicKey: {} as CryptoKey }) };
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

integration("certificate inventory concurrency (disposable PostgreSQL only)", () => {
  const first = new PrismaClient({ datasourceUrl: databaseUrl });
  const second = new PrismaClient({ datasourceUrl: databaseUrl });
  const observer = new PrismaClient({ datasourceUrl: databaseUrl });
  let inventoryId: string;
  let gatewayId: string;
  let ca: any;
  let sequence = 0;
  beforeAll(async () => {
    // An explicit dedicated URL is mandatory; no fallback to DATABASE_URL.
    if (new URL(databaseUrl!).pathname !== "/pki_concurrency") throw new Error("dedicated disposable database required");
    await Promise.all([first.$connect(), second.$connect(), observer.$connect()]);
  });
  afterAll(async () => { await Promise.all([first.$disconnect(), second.$disconnect(), observer.$disconnect()]); });
  beforeEach(async () => {
    await first.gatewayCertificate.updateMany({ data: { replacedById: null } });
    await first.gatewayCertificate.deleteMany();
    await first.certificateRevocationReconciliation.deleteMany();
    await first.gatewayInventory.deleteMany();
    await first.gateway.deleteMany();
    await first.site.deleteMany();
    await first.user.deleteMany();
    await first.organization.deleteMany();
    const organization = await first.organization.create({ data: { name: "PKI fixture" } });
    const site = await first.site.create({ data: { name: "PKI fixture", organizationId: organization.id } });
    const gateway = await first.gateway.create({ data: { serialNumber: randomUUID(), name: "fixture", firmwareVersion: "test", siteId: site.id, certificateFingerprint: ACTIVE } });
    gatewayId = gateway.id;
    const inventory = await first.gatewayInventory.create({ data: { serialNumber: gateway.serialNumber, claimedGatewayId: gateway.id, certificateFingerprint: ACTIVE } });
    inventoryId = inventory.id;
    await first.gatewayCertificate.create({ data: { inventoryId, gatewayId, purpose: "device", certificateSerial: "01", fingerprint: ACTIVE, issuer: "device-ca", status: "active", notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + 86400000) } });
    await first.gatewayCertificate.create({ data: { inventoryId, gatewayId, purpose: "device", certificateSerial: "02", fingerprint: PENDING, issuer: "device-ca", status: "pending", notBefore: new Date(), notAfter: new Date(Date.now() + 864000000) } });
    sequence = 10;
    ca = {
      signCsr: jest.fn(async () => signed()),
      revoke: jest.fn(async () => { throw new Error("provider-secret"); }),
      rebuildCrl: jest.fn(),
      readCrl: jest.fn()
    };
  });
  function signed() {
    sequence += 1;
    return { certificatePem: "fixture-public-certificate", caChainPem: ["fixture-ca"], issuer: "fixture-ca", certificateSerial: sequence.toString(16), fingerprint: sequence.toString(16).padStart(64, "0"), notBefore: new Date().toISOString(), notAfter: new Date(Date.now() + 864000000).toISOString() };
  }
  function services(db: any) {
    const reconciliation = new CertificateRevocationReconciliationService(db, ca);
    const lifecycle = new CertificateLifecycleService(db, ca, validator, undefined, undefined, reconciliation);
    return { lifecycle, mqtt: new GatewayCertificateService(db, ca, validator, reconciliation), disable: new GatewayOnboardingService(db, {} as never, lifecycle),
      manufacturing: new ManufacturingEnrollmentService(db, ca, validator, { apiCaBundlePem: "fixture", mqttCaBundlePem: "fixture", manufacturingCaFingerprint: null }, reconciliation) };
  }

  it("recovers a ledgerless legacy revoked certificate through lifecycle retry without changing its revocation history", async () => {
    const legacyRevokedAt = new Date("2026-08-01T02:03:04.000Z");
    await first.gatewayCertificate.delete({ where: { fingerprint: PENDING } });
    const certificate = await first.gatewayCertificate.update({ where: { fingerprint: ACTIVE }, data: {
      status: "revoked", revokedAt: legacyRevokedAt
    } });
    await first.gatewayInventory.update({ where: { id: inventoryId }, data: { disabledAt: legacyRevokedAt, certificateFingerprint: null } });
    await first.gateway.update({ where: { id: gatewayId }, data: { certificateFingerprint: null } });
    expect(await first.certificateRevocationReconciliation.count()).toBe(0);

    ca.revoke.mockResolvedValue(undefined);
    ca.readCrl.mockResolvedValue(await createTestCrl([certificate.certificateSerial]));
    const publishCrl = jest.fn().mockRejectedValueOnce(new Error("fixture CRL destination unavailable"))
      .mockResolvedValue({ changed: true });
    const configuration = { deviceCrlPath: "/fixture/device.crl", publishCrl };
    const reconciliation = new CertificateRevocationReconciliationService(first as never, ca, configuration);
    const lifecycle = new CertificateLifecycleService(first as never, ca, validator, undefined, configuration, reconciliation);

    // Old deployments persisted status=revoked before publishing the CRL. That
    // status alone must not silently acknowledge this upgrade retry as complete.
    await expect(lifecycle.revokeInventoryCertificates(inventoryId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const pendingJobs = await first.certificateRevocationReconciliation.findMany({ where: { inventoryId } });
    expect(pendingJobs).toHaveLength(1);
    expect(pendingJobs[0]).toMatchObject({ certificateId: certificate.id, completedAt: null, cancelledAt: null, lastError: "crl_publish_failed" });
    expect(await first.gatewayCertificate.findUniqueOrThrow({ where: { id: certificate.id } })).toMatchObject({
      status: "revoked", revokedAt: legacyRevokedAt
    });

    await expect(lifecycle.revokeInventoryCertificates(inventoryId)).resolves.toEqual({ revoked: 1 });
    const completed = await first.certificateRevocationReconciliation.findUniqueOrThrow({ where: { id: pendingJobs[0].id } });
    expect(completed.completedAt).not.toBeNull();
    expect(await first.gatewayCertificate.findUniqueOrThrow({ where: { id: certificate.id } })).toMatchObject({
      status: "revoked", revokedAt: legacyRevokedAt
    });

    await expect(lifecycle.revokeInventoryCertificates(inventoryId)).resolves.toEqual({ revoked: 0 });
    expect(await first.certificateRevocationReconciliation.count({ where: { inventoryId } })).toBe(1);
    expect(await first.certificateRevocationReconciliation.count({ where: { inventoryId, completedAt: null } })).toBe(0);
    expect(await first.certificateRevocationReconciliation.findUniqueOrThrow({ where: { id: completed.id } })).toMatchObject({ completedAt: completed.completedAt });
    expect(await first.gatewayCertificate.findUniqueOrThrow({ where: { id: certificate.id } })).toMatchObject({
      status: "revoked", revokedAt: legacyRevokedAt
    });
    expect(ca.revoke).toHaveBeenCalledTimes(1);
    expect(publishCrl).toHaveBeenCalledTimes(2);
  });
  async function assertDisabled(expectedLedgerCount = 2) {
    expect(await first.gatewayCertificate.count({ where: { inventoryId, status: { in: ["active", "pending"] } } })).toBe(0);
    expect((await first.gatewayInventory.findUniqueOrThrow({ where: { id: inventoryId } })).certificateFingerprint).toBeNull();
    expect((await first.gateway.findUniqueOrThrow({ where: { id: gatewayId } })).certificateFingerprint).toBeNull();
    const ledger = await first.certificateRevocationReconciliation.findMany({ where: { inventoryId } });
    expect(ledger.length).toBe(expectedLedgerCount);
    expect(ledger.every(row => row.cancelledAt === null && row.completedAt === null)).toBe(true);
  }
  async function waitForLock(blockingPid?: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = blockingPid === undefined
        ? await observer.$queryRaw<any[]>`SELECT pid FROM pg_stat_activity WHERE datname = 'pki_concurrency' AND wait_event_type = 'Lock'`
        : await observer.$queryRaw<any[]>`
          SELECT activity.pid, activity.query, activity.wait_event, held.pid AS "blockingPid"
          FROM pg_stat_activity activity
          JOIN pg_locks waiting ON waiting.pid = activity.pid AND NOT waiting.granted
          JOIN pg_locks held ON held.locktype = waiting.locktype
            AND held.database = waiting.database AND held.classid = waiting.classid
            AND held.objid = waiting.objid AND held.objsubid = waiting.objsubid
            AND held.granted AND held.pid = ${blockingPid}
          WHERE activity.datname = 'pki_concurrency' AND activity.wait_event_type = 'Lock'
            AND waiting.locktype = 'advisory'
        `;
      if (rows.length) return rows[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("expected a PostgreSQL Lock wait on the inventory boundary");
  }
  // Pause after a real transaction mutation, retaining its actual PostgreSQL locks.
  function pausedInventoryUpdate(db: PrismaClient, reached: ReturnType<typeof barrier>, resume: ReturnType<typeof barrier>, onPause?: (tx: any) => Promise<void>) {
    return new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (callback: any, options: any) => target.$transaction(tx => callback(new Proxy(tx, { get(transaction, field) {
        if (field !== "gatewayInventory") return Reflect.get(transaction, field);
        return new Proxy(transaction.gatewayInventory, { get(delegate, method) {
          if (method !== "update") return Reflect.get(delegate, method);
          return async (args: any) => { const value = await delegate.update(args); await onPause?.(transaction); reached.release(); await resume.promise; return value; };
        } });
      } })), options);
    } });
  }
  const run = (kind: string, service: ReturnType<typeof services>) => kind === "mqtt"
    ? service.mqtt.issueMqttCertificate({ csrPem: "fixture-csr", deviceCertificateFingerprint: ACTIVE })
    : kind === "renew" ? service.lifecycle.renewDeviceCertificate({ csrPem: "fixture-csr", deviceCertificateFingerprint: ACTIVE })
    : service.lifecycle.activateDeviceCertificate({ deviceCertificateFingerprint: PENDING });

  it.each(["mqtt", "renew", "activate"])("disable-first blocks stale %s at the shared inventory lock", async kind => {
    if (kind === "renew") await first.gatewayCertificate.deleteMany({ where: { fingerprint: PENDING } });
    const reached = barrier(); const resume = barrier();
    const disabling = services(pausedInventoryUpdate(second, reached, resume)).disable.disableInventory(operator as never, inventoryId).catch(error => error);
    await reached.promise;
    const issuing = run(kind, services(first)).then(() => "issued", () => "rejected");
    try { await waitForLock(); } finally { resume.release(); }
    await disabling;
    expect(await issuing).toBe("rejected");
    expect(ca.signCsr).not.toHaveBeenCalled();
    if (kind === "renew") {
      expect(await first.certificateRevocationReconciliation.count({ where: { inventoryId } })).toBe(1);
      expect(await first.gatewayCertificate.count({ where: { status: { in: ["active", "pending"] } } })).toBe(0);
      expect((await first.gatewayInventory.findUniqueOrThrow({ where: { id: inventoryId } })).certificateFingerprint).toBeNull();
      expect((await first.gateway.findUniqueOrThrow({ where: { id: gatewayId } })).certificateFingerprint).toBeNull();
    } else await assertDisabled();
  });

  it.each(["mqtt", "renew", "activate"])("%s-first makes disable wait and revoke every committed identity", async kind => {
    if (kind === "renew") await first.gatewayCertificate.deleteMany({ where: { fingerprint: PENDING } });
    const reached = barrier(); const resume = barrier();
    ca.signCsr.mockImplementationOnce(async () => { reached.release(); await resume.promise; return signed(); });
    const issuing = run(kind, services(kind === "activate" ? pausedInventoryUpdate(first, reached, resume) : first));
    await reached.promise;
    const disabling = services(second).disable.disableInventory(operator as never, inventoryId).catch(error => error);
    try { await waitForLock(); } finally { resume.release(); }
    await issuing;
    await disabling;
    await assertDisabled(kind === "mqtt" ? 3 : 2);
  });

  it("serializes concurrent MQTT issuance and retains cancellation records", async () => {
    const reached = barrier(); const resume = barrier();
    ca.signCsr.mockImplementationOnce(async () => { reached.release(); await resume.promise; return signed(); });
    const firstIssuance = run("mqtt", services(first));
    await reached.promise;
    const secondIssuance = run("mqtt", services(second));
    try {
      await waitForLock();
      expect(ca.signCsr).toHaveBeenCalledTimes(1);
    } finally {
      resume.release();
    }
    await Promise.all([firstIssuance, secondIssuance]);
    expect(ca.signCsr).toHaveBeenCalledTimes(2);
    const [oldMqtt, newMqtt] = await first.gatewayCertificate.findMany({
      where: { fingerprint: { in: ["0".repeat(63) + "B", "0".repeat(63) + "C"] } },
      orderBy: { fingerprint: "asc" },
      select: { id: true, fingerprint: true, purpose: true, status: true, replacedById: true }
    });
    expect(oldMqtt).toMatchObject({ fingerprint: "0".repeat(63) + "B", purpose: "mqtt", status: "replaced" });
    expect(newMqtt).toMatchObject({ fingerprint: "0".repeat(63) + "C", purpose: "mqtt", status: "active", replacedById: null });
    expect(oldMqtt.replacedById).toBe(newMqtt.id);
    expect(oldMqtt.replacedById).not.toBe(oldMqtt.id);
    expect(await first.certificateRevocationReconciliation.count({ where: { cancelledAt: { not: null } } })).toBe(2);
  });

  it("normally renews then activates with both pointers and a cancelled orphan ledger", async () => {
    await first.gatewayCertificate.deleteMany({ where: { fingerprint: PENDING } });
    await run("renew", services(first));
    const pending = await first.gatewayCertificate.findFirstOrThrow({ where: { status: "pending" } });
    await services(second).lifecycle.activateDeviceCertificate({ deviceCertificateFingerprint: pending.fingerprint });
    expect(await first.gatewayCertificate.findMany({
      where: { purpose: "device" }, orderBy: { fingerprint: "asc" },
      select: { fingerprint: true, status: true, replacedById: true }
    })).toEqual([
      { fingerprint: "0".repeat(63) + "B", status: "active", replacedById: null },
      { fingerprint: ACTIVE, status: "replaced", replacedById: pending.id }
    ]);
    expect(await first.gatewayCertificate.count({ where: { purpose: "device", status: "pending" } })).toBe(0);
    expect((await first.gatewayInventory.findUniqueOrThrow({ where: { id: inventoryId } })).certificateFingerprint).toBe("0".repeat(63) + "B");
    expect((await first.gateway.findUniqueOrThrow({ where: { id: gatewayId } })).certificateFingerprint).toBe("0".repeat(63) + "B");
    expect(await first.certificateRevocationReconciliation.count({ where: { cancelledAt: { not: null } } })).toBe(1);
  });

  it.each(["disable-first", "sign-first"])("initial device enrollment participates in %s inventory exclusion", async order => {
    await first.gatewayCertificate.deleteMany();
    const inventory = await first.gatewayInventory.update({ where: { id: inventoryId }, data: { certificateFingerprint: null, claimedGatewayId: null } });
    await first.gateway.update({ where: { id: gatewayId }, data: { certificateFingerprint: null } });
    const enrollment = await services(first).manufacturing.createEnrollment({ serialNumber: inventory.serialNumber, stationIdentity: "fixture" });
    const reached = barrier(); const resume = barrier();
    ca.signCsr.mockImplementationOnce(async () => {
      if (order === "sign-first") { reached.release(); await resume.promise; }
      return { ...signed(), caChainPem: [rootCertificates[0]] };
    });
    const enroll = () => services(first).manufacturing.enrollDevice({ serialNumber: inventory.serialNumber, token: enrollment.enrollmentToken, csrPem: "fixture-csr" }).then(() => "issued", () => "rejected");
    let issuing: Promise<string>; let disabling: Promise<unknown>;
    if (order === "sign-first") {
      issuing = enroll(); await reached.promise;
      disabling = services(second).disable.disableInventory(operator as never, inventoryId).catch(error => error);
    } else {
      disabling = services(pausedInventoryUpdate(second, reached, resume)).disable.disableInventory(operator as never, inventoryId).catch(error => error);
      await reached.promise; issuing = enroll();
    }
    try { await waitForLock(); } finally { resume.release(); }
    expect(await issuing).toBe(order === "sign-first" ? "issued" : "rejected");
    await disabling;
    expect(await first.gatewayCertificate.count({ where: { status: { in: ["active", "pending"] } } })).toBe(0);
    expect((await first.gatewayInventory.findUniqueOrThrow({ where: { id: inventoryId } })).certificateFingerprint).toBeNull();
    expect(await first.certificateRevocationReconciliation.count({ where: { cancelledAt: null, completedAt: null } })).toBe(order === "sign-first" ? 1 : 0);
  });

  it.each(["mqtt", "renew"])("%s rollback retains a signed orphan and a fresh worker completes its revocation", async kind => {
    if (kind === "renew") await first.gatewayCertificate.deleteMany({ where: { fingerprint: PENDING } });
    const broken = new Proxy(first, { get(db, key) {
      if (key !== "$transaction") return Reflect.get(db, key);
      return (callback: any, options: any) => db.$transaction(tx => callback(new Proxy(tx, { get(transaction, field) {
        if (field !== "gatewayCertificate") return Reflect.get(transaction, field);
        return new Proxy(transaction.gatewayCertificate, { get(delegate, method) {
          if (method !== "create") return Reflect.get(delegate, method);
          return async () => { throw new Error("database rejection after CA signing"); };
        } });
      } })), options);
    } });
    await expect(run(kind, services(broken))).rejects.toThrow();
    const orphan = await second.certificateRevocationReconciliation.findFirstOrThrow();
    expect(orphan.cancelledAt).toBeNull();
    expect(orphan.completedAt).toBeNull();
    expect(orphan.fingerprint).toBe("0".repeat(63) + "B");
    expect(await second.gatewayCertificate.count({ where: { fingerprint: orphan.fingerprint } })).toBe(0);
    await second.certificateRevocationReconciliation.update({ where: { id: orphan.id }, data: { nextAttemptAt: new Date(0) } });
    ca.revoke.mockResolvedValue(undefined);
    ca.readCrl.mockResolvedValue(await createTestCrl([orphan.certificateSerial]));
    const restarted = new CertificateRevocationReconciliationService(second as never, ca, { deviceCrlPath: "/fixture/device.crl", mqttCrlPath: "/fixture/mqtt.crl", publishCrl: jest.fn().mockResolvedValue({ changed: true }) });
    await restarted.processNow(orphan.id);
    const completed = await second.certificateRevocationReconciliation.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(completed.cancelledAt).toBeNull();
    expect(completed.revokedAt).not.toBeNull();
    expect(completed.completedAt).not.toBeNull();
  });

  it("site deletion waits for MQTT signing and retains every revocation after Gateway cascade", async () => {
    const gateway = await first.gateway.findUniqueOrThrow({ where: { id: gatewayId }, include: { site: true } });
    const admin = await first.user.create({ data: { organizationId: gateway.site.organizationId, loginId: randomUUID(), name: "fixture", passwordHash: "fixture", role: "admin" } });
    await first.site.update({ where: { id: gateway.siteId }, data: { adminUserId: admin.id } });
    const reached = barrier(); const resume = barrier();
    ca.signCsr.mockImplementationOnce(async () => { reached.release(); await resume.promise; return signed(); });
    const issuance = run("mqtt", services(first));
    await reached.promise;
    const deletion = new OperatorSiteAdminsService(second as never, {} as never, { record: async () => undefined } as never,
      { prepareReportDeletion: async () => null, processNow: async () => undefined } as never, services(second).lifecycle);
    const deleting = deletion.deleteSiteAdmin(operator as never, admin.id, gateway.site.name)
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try { await waitForLock(); } finally { resume.release(); }
    await issuance;
    const outcome = await deleting;
    // Serializable deletion may observe a pre-sign snapshot; retry is safe and
    // explicitly required by the API's existing conflict contract.
    if (!outcome.ok) {
      if (!(outcome.error instanceof HttpException) || outcome.error.getStatus() !== 409) throw outcome.error;
      await deletion.deleteSiteAdmin(operator as never, admin.id, gateway.site.name);
    }
    expect(await first.gateway.count({ where: { id: gatewayId } })).toBe(0);
    expect(await first.gatewayCertificate.count({ where: { inventoryId, status: { in: ["active", "pending"] } } })).toBe(0);
    expect((await first.gatewayInventory.findUniqueOrThrow({ where: { id: inventoryId } })).certificateFingerprint).toBeNull();
    expect(await first.certificateRevocationReconciliation.count({ where: { inventoryId, cancelledAt: null } })).toBe(3);
  });

  it.each([
    { kind: "mqtt", ledgerCount: 2 },
    { kind: "renew", ledgerCount: 1 },
    { kind: "activate", ledgerCount: 2 }
  ])("site-delete-first blocks $kind at the same inventory lock and rejects it after cascade", async ({ kind, ledgerCount }) => {
    // Each table row has its own beforeEach database fixture. Renewal starts
    // without a pending certificate; activation needs its independent pending.
    if (kind === "renew") await first.gatewayCertificate.deleteMany({ where: { fingerprint: PENDING } });
    const gateway = await first.gateway.findUniqueOrThrow({ where: { id: gatewayId }, include: { site: true } });
    const admin = await first.user.create({ data: {
      organizationId: gateway.site.organizationId, loginId: randomUUID(), name: "fixture", passwordHash: "fixture", role: "admin"
    } });
    await first.site.update({ where: { id: gateway.siteId }, data: { adminUserId: admin.id } });

    const reached = barrier(); const resume = barrier();
    let deletionPid = 0;
    const deletionDb = pausedInventoryUpdate(second, reached, resume, async tx => {
      const rows = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      deletionPid = rows[0].pid;
    });
    const deletion = new OperatorSiteAdminsService(deletionDb as never, {} as never, { record: async () => undefined } as never,
      { prepareReportDeletion: async () => null, processNow: async () => undefined } as never, services(deletionDb).lifecycle);
    const deleting = deletion.deleteSiteAdmin(operator as never, admin.id, gateway.site.name);
    await reached.promise;
    const issuing = run(kind, services(first)).then(() => "issued", () => "rejected");
    try {
      // The real inventory UPDATE is still uncommitted, and the competing
      // operation waits on the exact advisory key held by that deletion PID.
      expect((await observer.gatewayInventory.findUniqueOrThrow({ where: { id: inventoryId } })).disabledAt).toBeNull();
      const waiting = await waitForLock(deletionPid);
      expect(waiting.blockingPid).toBe(deletionPid);
      expect(waiting.wait_event).toBe("advisory");
      expect(waiting.query).toContain("pg_advisory_xact_lock");
      expect(ca.signCsr).not.toHaveBeenCalled();
    } finally {
      resume.release();
      // Drain both real transactions before the next isolated fixture, even
      // when an assertion fails while locks are held.
      await Promise.allSettled([deleting, issuing]);
    }
    await expect(deleting).resolves.toEqual({ ok: true });
    expect(await issuing).toBe("rejected");
    expect(ca.signCsr).not.toHaveBeenCalled();
    expect(await first.site.count({ where: { id: gateway.siteId } })).toBe(0);
    expect(await first.gateway.count({ where: { id: gatewayId } })).toBe(0);
    const inventory = await first.gatewayInventory.findUniqueOrThrow({ where: { id: inventoryId } });
    expect(inventory.disabledAt).not.toBeNull();
    expect(inventory.certificateFingerprint).toBeNull();
    expect(inventory.claimedGatewayId).toBeNull();
    expect(await first.gatewayCertificate.count({ where: { inventoryId, status: { in: ["active", "pending"] } } })).toBe(0);
    const ledger = await first.certificateRevocationReconciliation.findMany({ where: { inventoryId } });
    expect(ledger).toHaveLength(ledgerCount);
    for (const row of ledger) {
      expect(row.cancelledAt).toBeNull();
      expect(row.completedAt).toBeNull();
      expect(row.certificateId).not.toBeNull();
      expect(row.source).toBe("inventory_revocation");
      expect(await first.gatewayCertificate.findUnique({ where: { id: row.certificateId! } })).toMatchObject({
        inventoryId, gatewayId: null, status: "revocation_pending"
      });
    }
  });
});
