import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { GatewayRecommissionService } from "./gateway-recommission.service";
import { CertificateLifecycleService } from "../pki/certificate-lifecycle.service";
import { CertificateRevocationReconciliationService } from "../pki/certificate-revocation-reconciliation.service";
import { createTestCrl } from "../pki/crl.test-support";
import { ObjectStorageService } from "../storage/object-storage.service";
import { EnergyReportCleanupService } from "../energy/reports/energy-report-cleanup.service";

const enabled = process.env.GATEWAY_RECOMMISSION_DISPOSABLE_POSTGRES === "1";

(enabled ? describe : describe.skip)("gateway recommission migration on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let mqttCrl: string;
  let rootCrl: string;
  const claimCodeHash = `scrypt$${"ab".repeat(16)}$${"cd".repeat(64)}`;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    await db.$connect();
    mqttCrl = await createTestCrl(["10", "11", "12", "13"], "CN=MQTT Test", 0);
    rootCrl = await createTestCrl([], "CN=Root Test", 0);
  }, 30_000);

  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    await db.$executeRawUnsafe('TRUNCATE TABLE "GatewayInventory", "GatewayCertificate", "CertificateRevocationReconciliation", "GatewayRecommissionJob", "EnergyReportObjectCleanup" CASCADE');
  });

  it("atomically removes every installation history family, preserves device trust and keeps a late-PUT cleanup obligation", async () => {
    const installation = await seedCompleteInstallation();
    const runtime = resetRuntime();
    const preview = await runtime.service.preview(installation);
    const prepared = await runtime.service.prepare({ ...installation, resetDigest: preview.resetDigest });
    const before = await installationHistoryCounts();
    expect(Object.values(before).every(count => count > 0)).toBe(true);
    runtime.objects.add(installation.reportKey);
    const result = await (runtime.service as any).apply(prepared.jobId, preview.resetDigest, claimCodeHash);
    expect(result).toMatchObject({ jobId: prepared.jobId, status: "applied" });
    expect(await db.gatewayInventory.findUnique({ where: { id: installation.inventoryId } })).toMatchObject({
      claimedGatewayId: null, claimedAt: null, disabledAt: null, claimCodeHash, certificateFingerprint: "AA".repeat(32)
    });
    expect(await db.gatewayCertificate.findUnique({ where: { id: installation.deviceId } })).toMatchObject({ purpose: "device", status: "active", revokedAt: null });
    expect(await db.gatewayCertificate.count()).toBe(7);
    expect(await db.gatewayCertificate.findMany({ where: { purpose: "device" }, orderBy: { certificateSerial: "asc" }, select: { status: true, revokedAt: true } }))
      .toEqual([{ status: "active", revokedAt: null }, { status: "pending", revokedAt: null }, { status: "replaced", revokedAt: null }]);
    expect(await db.gatewayCertificate.count({ where: { purpose: "mqtt", status: "revoked" } })).toBe(4);
    expect(await db.certificateRevocationReconciliation.count({ where: { completedAt: { not: null } } })).toBe(4);
    expect(runtime.ca.revoke.mock.calls.every(([input]) => input.purpose === "mqtt")).toBe(true);
    expect(runtime.publish.mock.calls.every(([path]) => path === "/test/mqtt.crl")).toBe(true);
    expect(await db.gateway.findUnique({ where: { id: installation.gatewayId } })).toBeNull();
    const remaining = await installationHistoryCounts();
    expect(Object.values(remaining)).toEqual(Array(Object.keys(remaining).length).fill(0));
    expect(await db.site.findUnique({ where: { id: installation.siteId } })).not.toBeNull();
    expect(await db.floor.findUnique({ where: { id: installation.floorId } })).toMatchObject({ nextFixtureSequence: 0, mapRevision: 0 });
    expect(runtime.objects.size).toBe(0);
    const tombstone = await db.energyReportObjectCleanup.findUniqueOrThrow({ where: { reportId: installation.reportId } });
    expect(tombstone.objectKeys).toHaveLength(3);
    runtime.objects.add(installation.reportKey);
    await new EnergyReportCleanupService(db as never, runtime.storage).prune();
    expect(runtime.objects.size).toBe(0);
    expect(await db.energyReportJob.count()).toBe(0);
    expect(await (runtime.service as any).apply(prepared.jobId, preview.resetDigest, claimCodeHash)).toEqual(result);
    expect(runtime.ca.revoke).toHaveBeenCalledTimes(4);
    await expect((runtime.service as any).apply(prepared.jobId, preview.resetDigest, `scrypt$${"ef".repeat(16)}$${"01".repeat(64)}`)).rejects.toThrow();
  });

  it("rolls back the final large deletion, floor reset and hash change on a database failure and resumes without device revocation", async () => {
    const installation = await seedCompleteInstallation();
    const runtime = resetRuntime();
    const preview = await runtime.service.preview(installation);
    const prepared = await runtime.service.prepare({ ...installation, resetDigest: preview.resetDigest });
    const before = await installationHistoryCounts();
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_reset_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'applied' THEN RAISE EXCEPTION 'injected reset failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER fail_reset_completion BEFORE UPDATE ON "GatewayRecommissionJob" FOR EACH ROW EXECUTE FUNCTION fail_reset_completion()`);
    try {
      await expect((runtime.service as any).apply(prepared.jobId, preview.resetDigest, claimCodeHash)).rejects.toThrow();
      expect(await installationHistoryCounts()).toEqual(before);
      expect(await db.gatewayInventory.findUnique({ where: { id: installation.inventoryId } })).toMatchObject({ claimedGatewayId: installation.gatewayId, claimCodeHash: null });
      expect(await db.floor.findUnique({ where: { id: installation.floorId } })).toMatchObject({ nextFixtureSequence: 12, mapRevision: 4 });
      expect(await db.gatewayRecommissionJob.findUnique({ where: { id: prepared.jobId } })).toMatchObject({ status: "mqtt_revoked", appliedAt: null });
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER fail_reset_completion ON "GatewayRecommissionJob"');
      await db.$executeRawUnsafe('DROP FUNCTION fail_reset_completion()');
    }
    await expect((runtime.service as any).apply(prepared.jobId, preview.resetDigest, claimCodeHash)).resolves.toMatchObject({ status: "applied" });
    expect(runtime.ca.revoke).toHaveBeenCalledTimes(4);
  });

  it.each(["ca", "crl", "storage"])("keeps claimed inventory and report metadata on %s failure", async failure => {
    const installation = await seedCompleteInstallation();
    const runtime = resetRuntime();
    const preview = await runtime.service.preview(installation);
    const prepared = await runtime.service.prepare({ ...installation, resetDigest: preview.resetDigest });
    if (failure === "ca") runtime.ca.revoke.mockRejectedValue(new Error("provider-secret"));
    if (failure === "crl") runtime.publish.mockRejectedValue(new Error("provider-secret"));
    if (failure === "storage") runtime.send.mockRejectedValue(new Error("provider-secret"));
    const error = await (runtime.service as any).apply(prepared.jobId, preview.resetDigest, claimCodeHash).catch((value: unknown) => value);
    expect(String(error)).not.toContain("provider-secret");
    expect(await db.gatewayInventory.findUnique({ where: { id: installation.inventoryId } })).toMatchObject({ claimedGatewayId: installation.gatewayId, disabledAt: null });
    expect(await db.gatewayRecommissionJob.findUnique({ where: { id: prepared.jobId } })).not.toMatchObject({ status: "applied" });
    expect(await db.energyReportJob.count()).toBe(1);
  });

  it.each(["digest", "processing", "status", "keys", "device", "child"])("rejects %s drift before external deletion or destructive SQL", async drift => {
    const installation = await seedCompleteInstallation();
    const runtime = resetRuntime();
    const preview = await runtime.service.preview(installation);
    const prepared = await runtime.service.prepare({ ...installation, resetDigest: preview.resetDigest });
    if (drift === "processing") await db.energyReportJob.update({ where: { id: installation.reportId }, data: { status: "processing", progressPercent: 1, failureCode: null, leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) } });
    if (drift === "status") await db.gatewayRecommissionJob.update({ where: { id: prepared.jobId }, data: { status: "failed" } });
    if (drift === "keys") await db.gatewayRecommissionJob.update({ where: { id: prepared.jobId }, data: { objectKeys: [installation.reportKey.replace(installation.siteId, randomUUID())] } });
    if (drift === "device") await db.gatewayInventory.update({ where: { id: installation.inventoryId }, data: { certificateFingerprint: "FF".repeat(32) } });
    if (drift === "child") await db.energyFixtureDimensionVersion.update({ where: { id: installation.dimensionId }, data: { id: randomUUID() } });
    await expect((runtime.service as any).apply(prepared.jobId, drift === "digest" ? "0".repeat(64) : preview.resetDigest, claimCodeHash)).rejects.toThrow();
    expect(runtime.send).not.toHaveBeenCalled();
    expect(runtime.ca.revoke).not.toHaveBeenCalled();
    expect(await db.gateway.findUnique({ where: { id: installation.gatewayId } })).not.toBeNull();
  });

  it("recomputes child targets after external cleanup and refuses an incomplete MQTT ledger", async () => {
    const installation = await seedCompleteInstallation();
    const runtime = resetRuntime();
    const preview = await runtime.service.preview(installation);
    const prepared = await runtime.service.prepare({ ...installation, resetDigest: preview.resetDigest });
    runtime.send.mockImplementationOnce(async () => {
      await db.certificateRevocationReconciliation.updateMany({ where: { purpose: "mqtt" }, data: { completedAt: null } });
      return {};
    });
    await expect((runtime.service as any).apply(prepared.jobId, preview.resetDigest, claimCodeHash)).rejects.toThrow();
    expect(await db.gateway.findUnique({ where: { id: installation.gatewayId } })).not.toBeNull();
  });

  it("recomputes exact child targets again after object deletion", async () => {
    const installation = await seedCompleteInstallation();
    const runtime = resetRuntime();
    const preview = await runtime.service.preview(installation);
    const prepared = await runtime.service.prepare({ ...installation, resetDigest: preview.resetDigest });
    runtime.send.mockImplementationOnce(async () => {
      await db.energyFixtureDimensionVersion.update({ where: { id: installation.dimensionId }, data: { id: randomUUID() } });
      return {};
    });
    await expect((runtime.service as any).apply(prepared.jobId, preview.resetDigest, claimCodeHash)).rejects.toThrow();
    expect(await db.gateway.findUnique({ where: { id: installation.gatewayId } })).not.toBeNull();
  });

  it("enforces the named status domain and one active reset fence per inventory", async () => {
    const constraints = await db.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"GatewayRecommissionJob"'::regclass AND conname = 'GatewayRecommissionJob_status_check'
    `;
    expect(constraints).toEqual([{ conname: "GatewayRecommissionJob_status_check" }]);
    const insert = (id: string, inventoryId: string, status: string) => db.$executeRawUnsafe(
      `INSERT INTO "GatewayRecommissionJob" ("id", "siteId", "inventoryId", "gatewayId", "serialNumber", "resetDigest", "targetSnapshot", "objectKeys", "status", "updatedAt")
       VALUES ('${id}', 'site-1', '${inventoryId}', 'gateway-1', 'GW-001', 'digest', '{}', '[]', '${status}', now())`
    );
    await expect(insert("job-1", "inventory-1", "prepared")).resolves.toBe(1);
    await expect(insert("job-2", "inventory-1", "mqtt_revoked")).rejects.toThrow();
    await expect(insert("job-3", "inventory-2", "not-a-status")).rejects.toThrow();
    await expect(insert("job-4", "inventory-1", "finalized")).resolves.toBe(1);
  });

  it("persists a real preview/prepare snapshot containing a nonempty watermark", async () => {
    const installation = await seedInstallation();
    await db.gatewayEventWatermark.create({ data: {
      gatewayId: installation.gatewayId, eventType: "fixture_state", scopeKey: "fixture:1",
      lastSequence: 3n, lastEventId: randomUUID(), lastOccurredAt: new Date("2026-09-14T00:00:03.000Z")
    } });
    const recommission = new GatewayRecommissionService(db as never);

    const preview = await recommission.preview(installation);
    const prepared = await recommission.prepare({ ...installation, resetDigest: preview.resetDigest });
    const saved = await db.gatewayRecommissionJob.findUniqueOrThrow({ where: { id: prepared.jobId } });

    expect(preview.counts.gatewayEventWatermark).toBe(1);
    expect(prepared.status).toBe("prepared");
    expect(saved.targetSnapshot)
      .toMatchObject({ deletionIds: { gatewayEventWatermark: [JSON.stringify(["fixture_state", "fixture:1"])] } });
  });

  it("includes open and resolved fixture incidents and changes the digest when an equal-count row is replaced", async () => {
    const installation = await seedInstallation();
    const firstIncident = await fixtureIncident(installation, "open");
    const resolvedIncident = await fixtureIncident(installation, "resolved");
    const recommission = new GatewayRecommissionService(db as never);

    const baseline = await recommission.preview(installation);
    await db.monitoringIncident.delete({ where: { id: firstIncident.id } });
    await fixtureIncident(installation, "open");
    const replaced = await recommission.preview(installation);

    expect(baseline.counts.monitoringIncident).toBe(2);
    expect(replaced.counts.monitoringIncident).toBe(2);
    expect(replaced.resetDigest).not.toBe(baseline.resetDigest);
    expect(resolvedIncident.status).toBe("resolved");
  });

  it("includes retired Site energy identities and daily/hourly aggregate history", async () => {
    const installation = await seedInstallation();
    const retiredFixture = await db.energyFixtureIdentity.create({ data: {
      siteId: installation.siteId, fixtureId: null, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z"), retiredAt: new Date("2026-02-01T00:00:00.000Z")
    } });
    await db.energyGroupIdentity.create({ data: {
      siteId: installation.siteId, groupId: null, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z"), retiredAt: new Date("2026-02-01T00:00:00.000Z")
    } });
    await db.fixtureEnergyDailyAggregate.create({ data: {
      energyFixtureId: retiredFixture.id, fixtureId: null, localDate: new Date("2026-01-02T00:00:00.000Z"), estimatedKwh: "1.0", estimatedCost: "100.0"
    } });
    await db.fixtureEnergyHourlyAggregate.create({ data: {
      energyFixtureId: retiredFixture.id, bucketStartUtc: new Date("2026-01-02T00:00:00.000Z"), localDate: new Date("2026-01-02T00:00:00.000Z"),
      localHour: 9, utcOffsetMinutes: 540, estimatedKwh: "1.0", brightnessWeightedSeconds: "100.0"
    } });

    const preview = await new GatewayRecommissionService(db as never).preview(installation);

    expect(preview.counts.energyFixtureIdentity).toBe(1);
    expect(preview.counts.energyGroupIdentity).toBe(1);
    expect(preview.counts.energyAggregate).toBe(2);
  });

  function resetRuntime() {
    const ca = { signCsr: jest.fn(), revoke: jest.fn(async (_input: { purpose: string }) => undefined),
      rebuildCrl: jest.fn(async () => undefined), readCrl: jest.fn(async () => mqttCrl) };
    const publish = jest.fn(async (_path: string, _crl: string, _root: string) => ({ changed: true as const }));
    const configuration = { mqttCrlPath: "/test/mqtt.crl", deviceCrlPath: "/test/device.crl", trustedRootCrlPem: rootCrl, publishCrl: publish };
    const reconciliation = new CertificateRevocationReconciliationService(db as never, ca as never, configuration);
    const certificates = new CertificateLifecycleService(db as never, ca as never, {} as never, undefined, configuration, reconciliation);
    const objects = new Set<string>();
    const send = jest.fn(async (command: { constructor: { name: string }; input: { Key?: string } }) => {
      const key = command.input.Key!;
      if (command.constructor.name === "HeadObjectCommand") {
        if (!objects.has(key)) throw { $metadata: { httpStatusCode: 404 } };
        return { ContentLength: 12 };
      }
      objects.delete(key);
      return {};
    });
    const storage = new ObjectStorageService({ send } as never, { bucket: "floor-assets", publicBaseUrl: "" });
    const Service = GatewayRecommissionService as any;
    return { service: new Service(db, certificates, storage) as GatewayRecommissionService, certificates, storage, ca, publish, objects, send };
  }

  async function installationHistoryCounts() {
    const tables = ["Fixture", "MeshNode", "FixtureGroup", "GroupFixture", "Command", "CommandDispatch", "CommandFixtureResult", "MqttOutbox",
      "GatewayAutomationConfiguration", "LightingSchedule", "LightingScheduleFixture", "VehicleEventRule", "VehicleEventSource", "VehicleEventTarget",
      "ManualOverride", "ManualOverrideFixture", "AutomationExecution", "AutomationExecutionFixtureResult", "ProvisioningSession", "ProvisioningScanOutbox",
      "ProvisioningDeviceOutbox", "DiscoveredMeshNode", "MonitoringIncident", "ProcessedGatewayEvent", "GatewayEventWatermark", "GatewayClaimAudit",
      "EnergyUsage", "FixtureEnergyStateCursor", "EnergyFixtureIdentity", "EnergyFixtureDimensionVersion", "EnergyGroupIdentity", "EnergyGroupDimensionVersion",
      "EnergyGroupMembershipVersion", "FixtureEnergyHourlyAggregate", "FixtureEnergyDailyAggregate", "EnergyReportJob", "FloorMapRevision",
      "MeshControlGroup", "MeshControlGroupMember", "MeshControlGroupExpectedOperation", "MeshControlGroupAppliedMember"];
    return Object.fromEntries(await Promise.all(tables.map(async table => {
      const rows = await db.$queryRawUnsafe<Array<{ count: number }>>(`SELECT count(*)::integer AS count FROM "${table}"`);
      return [table, rows[0].count] as const;
    })));
  }

  async function seedCompleteInstallation() {
    const installation = await seedInstallation();
    const { siteId, gatewayId, fixtureId, floorId, inventoryId, nodeId, organizationId } = installation;
    const time = new Date("2026-09-01T00:00:00Z");
    const user = await db.user.create({ data: { organizationId, loginId: randomUUID(), name: "Installer", passwordHash: "test", role: "admin" } });
    await db.floor.update({ where: { id: floorId }, data: { nextFixtureSequence: 12, mapRevision: 4 } });
    await db.gatewayInventory.update({ where: { id: inventoryId }, data: { certificateFingerprint: "AA".repeat(32) } });
    await db.gateway.update({ where: { id: gatewayId }, data: { certificateFingerprint: "AA".repeat(32) } });
    let deviceId = "";
    for (const [index, status] of (["active", "pending", "replaced"] as const).entries()) {
      const certificate = await db.gatewayCertificate.create({ data: { inventoryId, gatewayId, purpose: "device", status,
        certificateSerial: `A${index}`, fingerprint: index === 0 ? "AA".repeat(32) : `A${index}`.repeat(32), issuer: "device-ca", notBefore: time, notAfter: new Date("2027-09-01") } });
      if (index === 0) deviceId = certificate.id;
    }
    for (const [index, status] of (["active", "pending", "replaced", "revoked"] as const).entries()) {
      await db.gatewayCertificate.create({ data: { inventoryId, gatewayId, purpose: "mqtt", status, revokedAt: status === "revoked" ? time : null,
        certificateSerial: `1${index}`, fingerprint: `B${index}`.repeat(32), issuer: "mqtt-ca", notBefore: time, notAfter: new Date("2027-09-01") } });
    }
    const group = await db.fixtureGroup.create({ data: { siteId, floorId, gatewayId, name: "Group", groupFixtures: { create: { fixtureId } } } });
    await db.fixtureGroup.create({ data: { siteId, name: "Retired group", lifecycleStatus: "retired", floorId: null, gatewayId: null } });
    const meshGroup = await db.meshControlGroup.create({ data: { gatewayId, targetType: "floor", targetId: floorId, groupAddress: "0xC001" } });
    await db.meshControlGroupMember.create({ data: { groupId: meshGroup.id, gatewayId, meshNodeId: nodeId } });
    await db.meshControlGroupAppliedMember.create({ data: { groupId: meshGroup.id, gatewayId, meshNodeId: nodeId, meshAddress: "0x1001" } });
    await db.meshControlGroupExpectedOperation.create({ data: { groupId: meshGroup.id, gatewayId, meshNodeId: nodeId, meshAddress: "0x1001", configurationVersion: 1, action: "add" } });
    const command = await db.command.create({ data: { siteId, clientRequestId: randomUUID(), requestFingerprint: "test", targetType: "fixture", brightness: 50 } });
    await db.command.create({ data: { siteId, clientRequestId: randomUUID(), requestFingerprint: "retired", targetType: "fixture", brightness: 50 } });
    const dispatch = await db.commandDispatch.create({ data: { gatewayId, commandId: command.id, idempotencyKey: randomUUID(), sequence: 1n, meshControlGroupId: meshGroup.id } });
    await db.commandFixtureResult.create({ data: { dispatchId: dispatch.id, fixtureId } });
    await db.mqttOutbox.create({ data: { dispatchId: dispatch.id, topic: "test", payload: {} } });
    await db.mqttOutbox.create({ data: { gatewayId, topic: "test/config", payload: {}, revision: 1, payloadHash: `sha256:${"a".repeat(64)}` } });
    await db.gatewayAutomationConfiguration.create({ data: { siteId, gatewayId } });
    const schedule = await db.lightingSchedule.create({ data: { siteId, gatewayId, name: "Schedule", activeFrom: time, activeUntil: new Date("2027-01-01"),
      localStartTime: "09:00", localEndTime: "18:00", recurrenceKind: "daily", dimmingEnabled: true, brightnessPercent: 50, createdById: user.id, updatedById: user.id,
      fixtures: { create: { fixtureId } } } });
    await db.meshNode.update({ where: { id: nodeId }, data: { vehicleSensorCapabilityStatus: "supported", vehicleSensorCapabilityVerifiedAt: time, vehicleSensorCapabilityRevision: 1n, vehicleSensorServerBound: true, vehicleVendorEventModelBound: true } });
    await db.vehicleEventRule.create({ data: { siteId, gatewayId, name: "Vehicle", dimmingEnabled: true, brightnessPercent: 70, createdById: user.id, updatedById: user.id,
      sources: { create: { fixtureId } }, targets: { create: { fixtureId } } } });
    await db.manualOverride.create({ data: { siteId, gatewayId, commandId: command.id, brightnessPercent: 50, startedAt: time, overrideUntil: new Date("2026-09-02"),
      fixtures: { create: { fixtureId } } } });
    const execution = await db.automationExecution.create({ data: { siteId, gatewayId, eventId: randomUUID(), sequence: 2n, revision: 1, kind: "schedule_started", ruleId: schedule.id, lightingScheduleId: schedule.id, occurredAt: time, payload: {} } });
    await db.automationExecutionFixtureResult.create({ data: { executionId: execution.id, fixtureSnapshotId: "retired-fixture", fixtureId: null, status: "succeeded", occurredAt: time } });
    const retiredSchedule = await db.lightingSchedule.create({ data: { ...schedule, id: randomUUID(), targetCount: 0, fixtures: { create: { fixtureId } } } });
    await db.automationExecution.create({ data: { siteId, gatewayId, eventId: randomUUID(), sequence: 3n, revision: 1, kind: "schedule_started", ruleId: retiredSchedule.id,
      lightingScheduleId: retiredSchedule.id, occurredAt: time, payload: {} } });
    await db.lightingSchedule.delete({ where: { id: retiredSchedule.id } });
    const session = await db.provisioningSession.create({ data: { siteId, gatewayId, floorId, requestedBy: user.id } });
    const discovered = await db.discoveredMeshNode.create({ data: { sessionId: session.id, deviceUuid: randomUUID(), serialNumber: "unclaimed", rssi: -60, oobCapability: "none", firmwareVersion: "test" } });
    await db.provisioningScanOutbox.create({ data: { sessionId: session.id, scanAttempt: 1, topic: "scan", payload: {} } });
    await db.provisioningDeviceOutbox.create({ data: { sessionId: session.id, nodeId: discovered.id, topic: "provision", payload: {} } });
    await fixtureIncident(installation, "open");
    await fixtureIncident(installation, "resolved");
    await db.processedGatewayEvent.create({ data: { gatewayId, eventId: randomUUID(), eventType: "fixture_state", sequence: 1n, occurredAt: time, payloadHash: `sha256:${"a".repeat(64)}` } });
    await db.gatewayEventWatermark.create({ data: { gatewayId, eventType: "fixture_state", scopeKey: fixtureId, lastSequence: 1n, lastEventId: randomUUID(), lastOccurredAt: time } });
    await db.gatewayClaimAudit.create({ data: { inventoryId, siteId, serialNumber: installation.serialNumber, outcome: "claimed" } });
    await db.gatewayClaimAudit.create({ data: { inventoryId: null, siteId, serialNumber: installation.serialNumber, outcome: "failed" } });
    await db.gatewayClaimAudit.create({ data: { inventoryId, siteId: null, serialNumber: installation.serialNumber, outcome: "failed" } });
    await db.energyUsage.create({ data: { fixtureId, source: "estimated", period: "daily", kwh: 1, cost: 100 } });
    await db.fixtureEnergyStateCursor.create({ data: { fixtureId, aggregatedThrough: time, brightness: 50, ratedWatt: 40, durationRemainders: {} } });
    let dimensionId = "";
    for (const retired of [false, true]) {
      const energy = await db.energyFixtureIdentity.create({ data: { siteId, fixtureId: retired ? null : fixtureId, trackingStartedAt: time, retiredAt: retired ? time : null } });
      const energyGroup = await db.energyGroupIdentity.create({ data: { siteId, groupId: retired ? null : group.id, trackingStartedAt: time, retiredAt: retired ? time : null } });
      const dimension = await db.energyFixtureDimensionVersion.create({ data: { energyFixtureId: energy.id, name: "L", floorId, floorName: "B1", ratedWatt: 40, effectiveFrom: time } });
      dimensionId = dimension.id;
      await db.energyGroupDimensionVersion.create({ data: { energyGroupId: energyGroup.id, name: "Group", effectiveFrom: time } });
      await db.energyGroupMembershipVersion.create({ data: { energyGroupId: energyGroup.id, energyFixtureId: energy.id, effectiveFrom: time } });
      await db.fixtureEnergyDailyAggregate.create({ data: { energyFixtureId: energy.id, fixtureId: retired ? null : fixtureId, localDate: time, estimatedKwh: 1, estimatedCost: 100 } });
      await db.fixtureEnergyHourlyAggregate.create({ data: { energyFixtureId: energy.id, bucketStartUtc: time, localDate: time, localHour: 9, utcOffsetMinutes: 540, estimatedKwh: 1, brightnessWeightedSeconds: 100 } });
    }
    const reportId = randomUUID();
    const reportKey = `reports/${siteId}/${reportId}/attempt-1.pdf`;
    await db.energyReportJob.create({ data: { id: reportId, siteId, requestedByActorId: user.id, requestedByLoginIdSnapshot: "installer", requestHash: "a".repeat(64), format: "pdf",
      status: "failed", startedAt: time, failureCode: "RENDER_FAILED", attemptCount: 1, requestSnapshot: { secret: "report-metadata" }, dataSnapshot: { secret: "report-data" }, objectKey: reportKey } });
    await db.floorMapRevision.create({ data: { floorId, revision: 4, snapshot: {}, snapshotSha256: "a".repeat(64), changeSummary: {}, changedBy: user.id } });
    return { ...installation, deviceId, reportId, reportKey, dimensionId };
  }

  async function seedInstallation() {
    const organization = await db.organization.create({ data: { name: `recommission-${randomUUID()}` } });
    const site = await db.site.create({ data: { organizationId: organization.id, name: "Recommission site" } });
    const floor = await db.floor.create({ data: { siteId: site.id, name: "B1", level: -1 } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, serialNumber: `GW-${randomUUID()}`, name: "Gateway", firmwareVersion: "test" } });
    const inventory = await db.gatewayInventory.create({ data: { serialNumber: gateway.serialNumber, claimedGatewayId: gateway.id, claimedAt: new Date() } });
    const node = await db.meshNode.create({ data: { gatewayId: gateway.id, meshAddress: "0x1001", firmwareVersion: "test" } });
    const fixture = await db.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "L01", ratedWatt: "40", x: 1, y: 1 } });
    return { siteId: site.id, serialNumber: gateway.serialNumber, gatewayId: gateway.id, fixtureId: fixture.id, floorId: floor.id, inventoryId: inventory.id, nodeId: node.id, organizationId: organization.id };
  }

  async function fixtureIncident(installation: Awaited<ReturnType<typeof seedInstallation>>, status: "open" | "resolved") {
    const now = new Date("2026-09-14T00:00:00.000Z");
    return db.monitoringIncident.create({ data: {
      siteId: installation.siteId, fixtureId: installation.fixtureId, type: "fixture_stale", targetKey: `fixture:${installation.fixtureId}`,
      status, activeKey: status === "open" ? `${installation.siteId}:fixture_stale:fixture:${installation.fixtureId}` : null,
      openedAt: now, lastObservedAt: now,
      ...(status === "resolved" ? { resolvedAt: now, resolutionKind: "automatic_recovery" } : {})
    } });
  }
});
