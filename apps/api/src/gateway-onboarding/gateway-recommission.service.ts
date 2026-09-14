import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type GatewayRecommissionJob, type GatewayCertificate } from "@prisma/client";
import { createHash } from "node:crypto";
import { reportAttemptKeys, type ReportObjectIdentity } from "../energy/reports/energy-report-cleanup.service";
import { PrismaService } from "../prisma/prisma.service";
import { CertificateLifecycleService, assertMqttRevocationCompleted } from "../pki/certificate-lifecycle.service";
import { ObjectStorageService } from "../storage/object-storage.service";

export type GatewayRecommissionCountKey =
  | "gateway" | "fixture" | "meshNode" | "fixtureGroup"
  | "provisioningSession" | "command" | "automationExecution"
  | "monitoringIncident" | "processedGatewayEvent" | "gatewayEventWatermark"
  | "energyFixtureIdentity" | "energyGroupIdentity" | "energyAggregate"
  | "energyReport" | "floorMapRevision" | "gatewayClaimAudit";

export interface GatewayRecommissionPreview {
  siteId: string;
  inventoryId: string;
  gatewayId: string;
  serialNumber: string;
  resetDigest: string;
  counts: Readonly<Record<GatewayRecommissionCountKey, number>>;
  certificates: { deviceActive: number; mqttActive: number; mqttPending: number };
}

export interface GatewayRecommissionPrepared {
  jobId: string;
  status: "prepared";
  resetDigest: string;
  preparedAt: Date;
}

interface GatewayRecommissionInput {
  siteId: string;
  serialNumber: string;
}

interface GatewayRecommissionPrepareInput extends GatewayRecommissionInput {
  resetDigest: string;
}

type LockedTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "gatewayRecommissionJob">;
type IdRow = { id: string };
type CertificateRow = GatewayCertificate;
type InventoryRow = { id: string; serialNumber: string; claimedGatewayId: string | null; disabledAt: Date | null; certificateFingerprint: string | null };
type GatewayRow = { id: string; siteId: string; serialNumber: string; certificateFingerprint: string | null };
type ReportRow = ReportObjectIdentity & { id: string; siteId: string; format: "xlsx" | "pdf"; attemptCount: number };

const countKeys: GatewayRecommissionCountKey[] = [
  "gateway", "fixture", "meshNode", "fixtureGroup", "provisioningSession", "command",
  "automationExecution", "monitoringIncident", "processedGatewayEvent", "gatewayEventWatermark",
  "energyFixtureIdentity", "energyGroupIdentity", "energyAggregate", "energyReport",
  "floorMapRevision", "gatewayClaimAudit"
];

@Injectable()
export class GatewayRecommissionService {
  constructor(private readonly prisma: PrismaService,
    private readonly certificates?: CertificateLifecycleService,
    private readonly storage?: ObjectStorageService) {}

  async apply(jobId: string, resetDigest: string, claimCodeHash: string) {
    if (typeof claimCodeHash !== "string" || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(claimCodeHash)) {
      throw new BadRequestException("invalid claim code hash");
    }
    const preflight = await this.prisma.$transaction(async tx => {
      const job = await this.lockJob(tx, jobId, resetDigest);
      if (job.status === "applied" || job.status === "finalized") return { job, applied: this.appliedResult(job, claimCodeHash) };
      await this.validateTargets(tx, job);
      return { job, applied: null };
    }, { timeout: 30_000 });
    if (preflight.applied) return preflight.applied;
    if (!this.certificates || !this.storage) throw new ConflictException("gateway recommission dependencies unavailable");
    await this.certificates.revokeMqttCertificatesForRecommission(preflight.job.inventoryId, jobId);
    // MQTT CRL 완료 이후에는 구 런타임을 절대로 재시작하지 않는다. 외부 DELETE와 DB
    // 트랜잭션은 함께 롤백할 수 없으므로 실패 시 mqtt_revoked 상태에서 동일 작업을 재시도한다.
    await this.storage.deleteRecordedReportObjects(preflight.job.objectKeys);
    return this.prisma.$transaction(async tx => {
      const job = await this.lockJob(tx, jobId, resetDigest);
      if (job.status === "applied" || job.status === "finalized") return this.appliedResult(job, claimCodeHash);
      if (job.status !== "mqtt_revoked") throw new ConflictException("gateway recommission MQTT revocation is incomplete");
      // 이 관리 작업은 nullable 이력까지 정확히 지운다. 기존 생산자 모두가 Site 행을
      // 잠그지는 않으므로 짧은 DB-only 구간에 명시적 테이블 쓰기 fence를 건다. 기존
      // 쓰기가 끝난 다음 스냅샷을 다시 계산하고, 검증~삭제 사이 신규 행 삽입도 막는다.
      await tx.$executeRaw(Prisma.sql`SELECT set_config('lock_timeout', '10000ms', true)`);
      await tx.$executeRaw(Prisma.sql`LOCK TABLE ${Prisma.raw(resetTables.map(table => `"${table}"`).join(", "))} IN SHARE ROW EXCLUSIVE MODE`);
      await this.validateTargets(tx, job);
      await assertMqttRevocationCompleted(tx, job.inventoryId);
      await this.resetInstallation(tx, job, claimCodeHash);
      const appliedAt = new Date();
      const saved = await tx.gatewayRecommissionJob.update({ where: { id: job.id }, data: {
        status: "applied", appliedAt, lastError: null,
        targetSnapshot: { ...(job.targetSnapshot as Prisma.JsonObject), appliedClaimCodeHashDigest: sha256(claimCodeHash) }
      } });
      return this.appliedResult(saved, claimCodeHash);
    }, { timeout: 30_000 });
  }

  private async lockJob(tx: Prisma.TransactionClient, jobId: string, resetDigest: string) {
    const rows = await tx.$queryRaw<GatewayRecommissionJob[]>(Prisma.sql`SELECT * FROM "GatewayRecommissionJob" WHERE "id" = ${jobId} FOR UPDATE`);
    const job = rows[0];
    if (!job) throw new NotFoundException("gateway recommission job not found");
    if (job.resetDigest !== resetDigest || !["prepared", "mqtt_revocation_pending", "mqtt_revoked", "applied", "finalized"].includes(job.status)) {
      throw new ConflictException("gateway recommission state changed");
    }
    return job;
  }

  private appliedResult(job: GatewayRecommissionJob, claimCodeHash: string) {
    const snapshot = job.targetSnapshot as Prisma.JsonObject;
    if (!job.appliedAt || snapshot.appliedClaimCodeHashDigest !== sha256(claimCodeHash)) {
      throw new ConflictException("gateway recommission claim hash differs");
    }
    return { jobId: job.id, status: "applied" as const, resetDigest: job.resetDigest, appliedAt: job.appliedAt };
  }

  private async validateTargets(tx: Prisma.TransactionClient, job: GatewayRecommissionJob) {
    const built = await this.buildPreview(tx, job);
    const recorded = job.targetSnapshot as unknown as typeof built.snapshot;
    if (sha256(canonicalJson(recorded)) !== job.resetDigest || canonicalJson(job.objectKeys) !== canonicalJson(recorded.objectKeys)) {
      throw new ConflictException("gateway recommission snapshot changed");
    }
    const processing = await tx.energyReportJob.count({ where: { siteId: job.siteId, status: "processing" } });
    if (processing) throw new ConflictException("gateway recommission report is processing");
    if (job.status !== "prepared") {
      const obligations = await tx.$queryRaw<IdRow[]>(Prisma.sql`
        SELECT certificate."id" FROM "GatewayCertificate" certificate
        JOIN "CertificateRevocationReconciliation" obligation ON obligation."certificateId" = certificate."id"
          AND obligation."inventoryId" = certificate."inventoryId" AND obligation."fingerprint" = certificate."fingerprint"
        WHERE certificate."inventoryId" = ${job.inventoryId} AND certificate."purpose" = 'mqtt' AND obligation."purpose" = 'mqtt'
          AND obligation."cancelledAt" IS NULL AND (obligation."source" = 'gateway_recommission' OR obligation."completedAt" IS NOT NULL)
      `);
      const allowed = new Set(obligations.map(row => row.id));
      built.snapshot.certificateState = built.snapshot.certificateState.map(current => {
        const original = recorded.certificateState.find(row => row.id === current.id);
        if (current.purpose !== "mqtt" || !original || !allowed.has(current.id) || original.status === "revoked") return current;
        if (![original.status, "revocation_pending", "revoked"].includes(current.status)) return current;
        return { ...current, status: original.status, revokedAt: original.revokedAt };
      });
      built.snapshot.certificates = { ...built.snapshot.certificates, mqttActive: recorded.certificates.mqttActive, mqttPending: recorded.certificates.mqttPending };
    }
    if (sha256(canonicalJson(built.snapshot)) !== job.resetDigest) throw new ConflictException("gateway recommission preview is stale");
  }

  private async resetInstallation(tx: Prisma.TransactionClient, job: GatewayRecommissionJob, claimCodeHash: string) {
    const siteId = job.siteId;
    // 실행 이력의 nullable source와 dispatch의 MeshControlGroup RESTRICT 참조를
    // 먼저 제거한다. 규칙/그룹을 Fixture보다 먼저 지워 cardinality trigger도 만족시킨다.
    await tx.automationExecution.deleteMany({ where: { siteId } });
    await tx.command.deleteMany({ where: { siteId } });
    await tx.lightingSchedule.deleteMany({ where: { siteId } });
    await tx.vehicleEventRule.deleteMany({ where: { siteId } });
    await tx.manualOverride.deleteMany({ where: { siteId } });
    await tx.provisioningSession.deleteMany({ where: { gatewayId: job.gatewayId } });
    await tx.monitoringIncident.deleteMany({ where: { siteId } });
    await tx.gatewayClaimAudit.deleteMany({ where: { OR: [{ inventoryId: job.inventoryId }, { siteId }] } });
    // 이미 삭제된 조명/그룹은 FK가 NULL이므로 Site 경계의 identity를 직접 지운다.
    // dimension, membership, 일/시간 집계는 해당 identity의 CASCADE로 함께 제거된다.
    await tx.energyGroupIdentity.deleteMany({ where: { siteId } });
    await tx.energyFixtureIdentity.deleteMany({ where: { siteId } });
    // 보고서 내용/요청 메타데이터는 삭제한다. DELETE trigger가 남기는 key-only
    // EnergyReportObjectCleanup은 고객 이력이 아닌 보안 정리 의무다. 중단됐던 worker의
    // 늦은 PUT은 유한 대기 시간으로 배제할 수 없어 이 tombstone은 삭제하지 않는다.
    await tx.energyReportJob.deleteMany({ where: { siteId } });
    await tx.floorMapRevision.deleteMany({ where: { floor: { siteId } } });
    await tx.fixtureGroup.deleteMany({ where: { siteId } });
    await tx.fixture.deleteMany({ where: { siteId } });
    await tx.gatewayInventory.update({ where: { id: job.inventoryId }, data: { claimedGatewayId: null, claimedAt: null, disabledAt: null, claimCodeHash } });
    await tx.gateway.delete({ where: { id: job.gatewayId } });
    await tx.floor.updateMany({ where: { siteId }, data: { nextFixtureSequence: 0, mapRevision: 0 } });
  }

  async preview(input: GatewayRecommissionInput): Promise<GatewayRecommissionPreview> {
    return this.prisma.$transaction(async tx => (await this.buildPreview(tx as LockedTransaction, input)).preview);
  }

  async prepare(input: GatewayRecommissionPrepareInput): Promise<GatewayRecommissionPrepared> {
    return this.prisma.$transaction(async tx => {
      const built = await this.buildPreview(tx as LockedTransaction, input);
      if (input.resetDigest !== built.preview.resetDigest) {
        throw new ConflictException("gateway recommission preview is stale");
      }
      try {
        const job = await (tx as LockedTransaction).gatewayRecommissionJob.create({
          data: {
            siteId: built.preview.siteId,
            inventoryId: built.preview.inventoryId,
            gatewayId: built.preview.gatewayId,
            serialNumber: built.preview.serialNumber,
            resetDigest: built.preview.resetDigest,
            targetSnapshot: built.snapshot,
            objectKeys: built.objectKeys,
            status: "prepared"
          }
        });
        return { jobId: job.id, status: "prepared" as const, resetDigest: job.resetDigest, preparedAt: job.preparedAt };
      } catch (error) {
        if (isActiveJobConflict(error)) throw new ConflictException("gateway recommission is already prepared");
        throw error;
      }
    });
  }

  private async buildPreview(tx: LockedTransaction, input: GatewayRecommissionInput) {
    const siteId = requiredText(input.siteId);
    const serialNumber = requiredText(input.serialNumber);

    // The order is intentional: Site, then inventory/certificates, then Gateway
    // establish the topology fence. This does not lock every child/retention row;
    // the later destructive worker must revalidate/fence this digest snapshot rather
    // than treating the preparation transaction as a broad deletion lock.
    const sites = await tx.$queryRaw<IdRow[]>(Prisma.sql`
      SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE
    `);
    if (sites.length !== 1) throw topologyError();

    const inventories = await tx.$queryRaw<InventoryRow[]>(Prisma.sql`
      SELECT "id", "serialNumber", "claimedGatewayId", "disabledAt", "certificateFingerprint"
      FROM "GatewayInventory" WHERE "serialNumber" = ${serialNumber} FOR UPDATE
    `);
    if (inventories.length !== 1 || inventories[0].disabledAt || !inventories[0].claimedGatewayId) throw topologyError();
    const inventory = inventories[0];

    const certificates = await tx.$queryRaw<CertificateRow[]>(Prisma.sql`
      SELECT * FROM "GatewayCertificate"
      WHERE "inventoryId" = ${inventory.id} ORDER BY "id" FOR UPDATE
    `);

    // Select every Gateway in the Site. Recommission is deliberately an exact
    // first-install reset, never a best-effort subset of a multi-Gateway site.
    const gateways = await tx.$queryRaw<GatewayRow[]>(Prisma.sql`
      SELECT "id", "siteId", "serialNumber", "certificateFingerprint" FROM "Gateway"
      WHERE "siteId" = ${siteId} ORDER BY "id" FOR UPDATE
    `);
    if (gateways.length !== 1 || gateways[0].id !== inventory.claimedGatewayId || gateways[0].serialNumber !== serialNumber) throw topologyError();
    const gateway = gateways[0];

    const gatewayRows = await ids(tx, Prisma.sql`SELECT "id" FROM "Gateway" WHERE "id" = ${gateway.id} ORDER BY "id"`);
    const fixtureRows = await tx.$queryRaw<Array<IdRow & { gatewayId: string | null }>>(Prisma.sql`
      SELECT "id", "gatewayId" FROM "Fixture" WHERE "siteId" = ${siteId} ORDER BY "id"
    `);
    // A Site with one Gateway must not carry a fixture whose assignment is absent
    // or points elsewhere; deleting only known rows would leave an unsafe hybrid.
    if (fixtureRows.some(row => row.gatewayId !== gateway.id)) throw topologyError();
    const fixtureIds = fixtureRows.map(row => row.id);
    const meshNodeRows = await ids(tx, Prisma.sql`SELECT "id" FROM "MeshNode" WHERE "gatewayId" = ${gateway.id} ORDER BY "id"`);
    const fixtureGroupRows = await ids(tx, Prisma.sql`SELECT "id" FROM "FixtureGroup" WHERE "siteId" = ${siteId} ORDER BY "id"`);
    const provisioningSessionRows = await ids(tx, Prisma.sql`SELECT "id" FROM "ProvisioningSession" WHERE "gatewayId" = ${gateway.id} ORDER BY "id"`);
    const commandRows = await ids(tx, Prisma.sql`SELECT "id" FROM "Command" WHERE "siteId" = ${siteId} ORDER BY "id"`);
    const automationExecutionRows = await ids(tx, Prisma.sql`SELECT "id" FROM "AutomationExecution" WHERE "gatewayId" = ${gateway.id} ORDER BY "id"`);
    // Fixture incidents intentionally have gatewayId=NULL; Site is the complete
    // validated installation boundary and includes resolved history too.
    const monitoringIncidentRows = await ids(tx, Prisma.sql`SELECT "id" FROM "MonitoringIncident" WHERE "siteId" = ${siteId} ORDER BY "id"`);
    const processedGatewayEventRows = await ids(tx, Prisma.sql`SELECT "eventId" AS "id" FROM "ProcessedGatewayEvent" WHERE "gatewayId" = ${gateway.id} ORDER BY "eventId"`);
    const watermarkRows = await tx.$queryRaw<Array<{ eventType: string; scopeKey: string }>>(Prisma.sql`
      SELECT "eventType", "scopeKey" FROM "GatewayEventWatermark" WHERE "gatewayId" = ${gateway.id}
      ORDER BY "eventType", "scopeKey"
    `);
    // Identity links are nullable after a prior fixture/group deletion. Site is the
    // durable installation boundary, so include both live and retired history.
    const energyFixtureIdentityRows = await idsBySite(tx, "EnergyFixtureIdentity", siteId);
    const energyGroupIdentityRows = await idsBySite(tx, "EnergyGroupIdentity", siteId);
    const energyAggregateRows = await aggregateIds(tx, fixtureIds, energyFixtureIdentityRows.map(row => row.id));
    const reportRows = await tx.$queryRaw<ReportRow[]>(Prisma.sql`
      SELECT "id", "siteId", "format", "attemptCount" FROM "EnergyReportJob"
      WHERE "siteId" = ${siteId} ORDER BY "id"
    `);
    const floorMapRevisionRows = await ids(tx, Prisma.sql`
      SELECT revision."id" FROM "FloorMapRevision" AS revision
      INNER JOIN "Floor" AS floor ON floor."id" = revision."floorId"
      WHERE floor."siteId" = ${siteId} ORDER BY revision."id"
    `);
    const gatewayClaimAuditRows = await ids(tx, Prisma.sql`
      SELECT "id" FROM "GatewayClaimAudit" WHERE "inventoryId" = ${inventory.id} OR "siteId" = ${siteId} ORDER BY "id"
    `);

    const rows = {
      gateway: gatewayRows, fixture: fixtureRows, meshNode: meshNodeRows, fixtureGroup: fixtureGroupRows,
      provisioningSession: provisioningSessionRows, command: commandRows, automationExecution: automationExecutionRows,
      monitoringIncident: monitoringIncidentRows, processedGatewayEvent: processedGatewayEventRows,
      // PostgreSQL JSONB rejects U+0000. A JSON tuple is collision-free for the
      // composite primary key and remains a valid string value in targetSnapshot.
      gatewayEventWatermark: watermarkRows.map(row => ({ id: JSON.stringify([row.eventType, row.scopeKey]) })),
      energyFixtureIdentity: energyFixtureIdentityRows, energyGroupIdentity: energyGroupIdentityRows,
      energyAggregate: energyAggregateRows, energyReport: reportRows, floorMapRevision: floorMapRevisionRows,
      gatewayClaimAudit: gatewayClaimAuditRows
    };
    const counts = Object.fromEntries(countKeys.map(key => [key, rows[key].length])) as Record<GatewayRecommissionCountKey, number>;
    const certificateCounts = {
      deviceActive: certificates.filter(row => row.purpose === "device" && row.status === "active").length,
      mqttActive: certificates.filter(row => row.purpose === "mqtt" && row.status === "active").length,
      mqttPending: certificates.filter(row => row.purpose === "mqtt" && row.status === "pending").length
    };
    const objectKeys = [...new Set(reportRows.flatMap(reportAttemptKeys))].sort();
    const children: Record<string, string[]> = {};
    for (const [table, columns, predicate] of childTargets(siteId, gateway.id)) {
      const rows = await ids(tx, Prisma.sql`SELECT jsonb_build_array(${Prisma.raw(columns.map(column => `"${column}"`).join(", "))})::text AS "id"
        FROM ${Prisma.raw(`"${table}"`)} WHERE ${predicate} ORDER BY "id"`);
      children[table] = rows.map(row => row.id).sort();
    }
    const floors = await tx.$queryRaw<Array<{ id: string; nextFixtureSequence: number; mapRevision: number }>>(Prisma.sql`
      SELECT "id", "nextFixtureSequence", "mapRevision" FROM "Floor" WHERE "siteId" = ${siteId} ORDER BY "id"
    `);
    const snapshot = {
      version: 2,
      siteId,
      inventoryId: inventory.id,
      gatewayId: gateway.id,
      serialNumber,
      counts,
      certificates: certificateCounts,
      certificateState: certificates.map(certificate => ({ id: certificate.id, purpose: certificate.purpose, status: certificate.status,
        revokedAt: certificate.revokedAt?.toISOString() ?? null,
        identityDigest: sha256(canonicalJson({ id: certificate.id, inventoryId: certificate.inventoryId, gatewayId: certificate.gatewayId,
          fingerprint: certificate.fingerprint, certificateSerial: certificate.certificateSerial, issuer: certificate.issuer,
          notBefore: certificate.notBefore?.toISOString(), notAfter: certificate.notAfter?.toISOString(), replacedById: certificate.replacedById })) })).sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")),
      trustPointersDigest: sha256(canonicalJson([inventory.certificateFingerprint, gateway.certificateFingerprint])),
      children,
      floors,
      deletionIds: Object.fromEntries(countKeys.map(key => [key, rows[key].map(row => row.id).sort()])),
      objectKeys
    };
    const resetDigest = sha256(canonicalJson(snapshot));
    return {
      preview: { siteId, inventoryId: inventory.id, gatewayId: gateway.id, serialNumber, resetDigest, counts, certificates: certificateCounts },
      snapshot,
      objectKeys
    };
  }
}

// 아래 식별자는 코드에 고정된 allowlist다. 사용자 입력으로 테이블명/컬럼명을 만들지 않는다.
function childTargets(siteId: string, gatewayId: string): Array<[string, string[], Prisma.Sql]> {
  const fixture = Prisma.sql`SELECT "id" FROM "Fixture" WHERE "siteId" = ${siteId}`;
  const group = Prisma.sql`SELECT "id" FROM "FixtureGroup" WHERE "siteId" = ${siteId}`;
  const commands = Prisma.sql`SELECT "id" FROM "Command" WHERE "siteId" = ${siteId}`;
  const dispatches = Prisma.sql`SELECT "id" FROM "CommandDispatch" WHERE "commandId" IN (${commands}) OR "gatewayId" = ${gatewayId}`;
  const sessions = Prisma.sql`SELECT "id" FROM "ProvisioningSession" WHERE "gatewayId" = ${gatewayId}`;
  const energyFixtures = Prisma.sql`SELECT "id" FROM "EnergyFixtureIdentity" WHERE "siteId" = ${siteId}`;
  const energyGroups = Prisma.sql`SELECT "id" FROM "EnergyGroupIdentity" WHERE "siteId" = ${siteId}`;
  return [
    ["GroupFixture", ["groupId", "fixtureId"], Prisma.sql`"groupId" IN (${group}) OR "fixtureId" IN (${fixture})`],
    ["CommandDispatch", ["id"], Prisma.sql`"commandId" IN (${commands}) OR "gatewayId" = ${gatewayId}`],
    ["CommandFixtureResult", ["dispatchId", "fixtureId"], Prisma.sql`"dispatchId" IN (${dispatches}) OR "fixtureId" IN (${fixture})`],
    ["MqttOutbox", ["id"], Prisma.sql`"dispatchId" IN (${dispatches}) OR "gatewayId" = ${gatewayId}`],
    ["GatewayAutomationConfiguration", ["gatewayId"], Prisma.sql`"gatewayId" = ${gatewayId}`],
    ["LightingSchedule", ["id"], Prisma.sql`"siteId" = ${siteId}`],
    ["LightingScheduleFixture", ["scheduleId", "fixtureId"], Prisma.sql`"siteId" = ${siteId}`],
    ["VehicleEventRule", ["id"], Prisma.sql`"siteId" = ${siteId}`],
    ["VehicleEventSource", ["ruleId", "fixtureId"], Prisma.sql`"siteId" = ${siteId}`],
    ["VehicleEventTarget", ["ruleId", "fixtureId"], Prisma.sql`"siteId" = ${siteId}`],
    ["ManualOverride", ["id"], Prisma.sql`"siteId" = ${siteId}`],
    ["ManualOverrideFixture", ["manualOverrideId", "fixtureId"], Prisma.sql`"siteId" = ${siteId}`],
    ["AutomationExecutionFixtureResult", ["executionId", "fixtureSnapshotId"], Prisma.sql`"executionId" IN (SELECT "id" FROM "AutomationExecution" WHERE "gatewayId" = ${gatewayId})`],
    ["DiscoveredMeshNode", ["id"], Prisma.sql`"sessionId" IN (${sessions})`],
    ["ProvisioningScanOutbox", ["id"], Prisma.sql`"sessionId" IN (${sessions})`],
    ["ProvisioningDeviceOutbox", ["id"], Prisma.sql`"sessionId" IN (${sessions})`],
    ["EnergyFixtureDimensionVersion", ["id"], Prisma.sql`"energyFixtureId" IN (${energyFixtures})`],
    ["EnergyGroupDimensionVersion", ["id"], Prisma.sql`"energyGroupId" IN (${energyGroups})`],
    ["EnergyGroupMembershipVersion", ["id"], Prisma.sql`"energyFixtureId" IN (${energyFixtures}) OR "energyGroupId" IN (${energyGroups})`],
    ["MeshControlGroup", ["id"], Prisma.sql`"gatewayId" = ${gatewayId}`],
    ["MeshControlGroupMember", ["groupId", "meshNodeId"], Prisma.sql`"gatewayId" = ${gatewayId}`],
    ["MeshControlGroupExpectedOperation", ["operationId"], Prisma.sql`"gatewayId" = ${gatewayId}`],
    ["MeshControlGroupAppliedMember", ["groupId", "meshNodeId", "meshAddress"], Prisma.sql`"gatewayId" = ${gatewayId}`]
  ];
}

const resetTables = [...new Set([
  "Floor", "GatewayInventory", "GatewayCertificate", "Gateway", "Fixture", "MeshNode", "FixtureGroup", "ProvisioningSession", "Command",
  "AutomationExecution", "MonitoringIncident", "ProcessedGatewayEvent", "GatewayEventWatermark", "GatewayClaimAudit", "EnergyFixtureIdentity",
  "EnergyGroupIdentity", "EnergyUsage", "FixtureEnergyStateCursor", "FixtureEnergyHourlyAggregate", "FixtureEnergyDailyAggregate", "EnergyReportJob", "FloorMapRevision",
  ...childTargets("", "").map(([table]) => table)
])].sort();

async function ids(tx: Pick<Prisma.TransactionClient, "$queryRaw">, query: Prisma.Sql) {
  return tx.$queryRaw<IdRow[]>(query);
}

async function idsBySite(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  table: "EnergyFixtureIdentity" | "EnergyGroupIdentity",
  siteId: string
) {
  const query = table === "EnergyFixtureIdentity"
    ? Prisma.sql`SELECT "id" FROM "EnergyFixtureIdentity" WHERE "siteId" = ${siteId} ORDER BY "id"`
    : Prisma.sql`SELECT "id" FROM "EnergyGroupIdentity" WHERE "siteId" = ${siteId} ORDER BY "id"`;
  return ids(tx, query);
}

async function aggregateIds(tx: Pick<Prisma.TransactionClient, "$queryRaw">, fixtureIds: string[], energyFixtureIds: string[]) {
  const rows: IdRow[] = [];
  if (fixtureIds.length) {
    rows.push(...await ids(tx, Prisma.sql`
      SELECT 'usage:' || "id" AS "id" FROM "EnergyUsage" WHERE "fixtureId" IN (${Prisma.join(fixtureIds)})
      UNION ALL
      SELECT 'cursor:' || "fixtureId" AS "id" FROM "FixtureEnergyStateCursor" WHERE "fixtureId" IN (${Prisma.join(fixtureIds)})
      ORDER BY "id"
    `));
  }
  if (energyFixtureIds.length) {
    rows.push(...await ids(tx, Prisma.sql`
      SELECT 'daily:' || "id" AS "id" FROM "FixtureEnergyDailyAggregate" WHERE "energyFixtureId" IN (${Prisma.join(energyFixtureIds)})
      UNION ALL
      SELECT 'hourly:' || "id" AS "id" FROM "FixtureEnergyHourlyAggregate" WHERE "energyFixtureId" IN (${Prisma.join(energyFixtureIds)})
      ORDER BY "id"
    `));
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function requiredText(value: string) {
  if (typeof value !== "string" || !value.trim()) throw topologyError();
  return value.trim();
}

function topologyError() {
  return new NotFoundException("gateway recommission topology not found");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isActiveJobConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
